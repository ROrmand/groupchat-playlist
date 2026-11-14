import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { JobQueue, queueNames } from '../src/jobs/queue.js';

test('fresh PostgreSQL 16 migrations, invariants, and queue worker', { timeout: 60000 }, async () => {
  const adminUrl = process.env.TEST_DATABASE_URL;
  assert.ok(adminUrl, 'TEST_DATABASE_URL must point to a disposable PostgreSQL 16 instance with CREATEDB permission');
  const admin = createPool(adminUrl);
  const databaseName = `baton_test_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const pool = createPool(databaseUrl.toString());
  let queue: JobQueue | undefined;
  let created = false;
  try {
    const version = await admin.query('SHOW server_version_num');
    assert.equal(Math.floor(Number(version.rows[0].server_version_num) / 10000), 16);
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await Promise.all([migrate(pool), migrate(pool)]);
    await migrate(pool);
    assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '4');

    const directory = await mkdtemp(join(tmpdir(), 'baton-migrations-'));
    try {
      for (const name of await readdir(resolve('migrations'))) {
        await writeFile(join(directory, name), await readFile(resolve('migrations', name)));
      }
      const initialSql = await readFile(resolve('migrations/001_initial_schema.sql'), 'utf8');
      await writeFile(join(directory, '001_initial_schema.sql'), `${initialSql}\nSELECT 1;`);
      await assert.rejects(migrate(pool, directory), /modified/);
      await writeFile(join(directory, '001_initial_schema.sql'), initialSql);
      await writeFile(join(directory, '005_failure.sql'), 'CREATE TABLE rollback_probe (id INTEGER); SELECT * FROM missing_table;');
      await assert.rejects(migrate(pool, directory), { code: '42P01' });
      assert.equal((await pool.query("SELECT to_regclass('rollback_probe') AS relation")).rows[0].relation, null);
      assert.equal((await pool.query('SELECT count(*) FROM schema_migrations')).rows[0].count, '4');
    } finally { await rm(directory, { recursive: true }); }

    const userId = randomUUID();
    const trackId = randomUUID();
    const groupId = randomUUID();
    const eventId = randomUUID();
    const itemId = randomUUID();
    const membershipId = randomUUID();
    await pool.query('INSERT INTO users (id, apple_sub, display_name) VALUES ($1, $2, $3)', [userId, 'apple-sub', 'Test User']);
    await pool.query(`INSERT INTO canonical_tracks (id, isrc, normalized_title, normalized_artist, fallback_dedup_key, duration_ms)
      VALUES ($1, 'USAAA2300001', 'test song', 'test artist', 'test song|test artist|60', 180000)`, [trackId]);
    await pool.query("INSERT INTO group_playlists (id, name, owner_id, invite_code) VALUES ($1, 'Test GC', $2, 'invite')", [groupId, userId]);
    await pool.query(`INSERT INTO streaming_connections (id, user_id, provider, encrypted_access_token, storefront, status)
      VALUES ($1, $1, 'test', 'offline-fixture', 'us', 'active')`, [userId]);
    await pool.query(`INSERT INTO playlist_memberships (id, group_playlist_id, user_id, status, streaming_connection_id, external_playlist_id)
      VALUES ($1, $2, $3, 'active', $3, 'offline-playlist')`, [membershipId, groupId, userId]);
    await assert.rejects(pool.query("INSERT INTO users (id, apple_sub, display_name) VALUES ($1, 'apple-sub', 'Duplicate')", [randomUUID()]), { code: '23505' });
    await assert.rejects(pool.query(`INSERT INTO playlist_memberships (id, group_playlist_id, user_id, status, streaming_connection_id, external_playlist_id)
      VALUES ($1, $2, $3, 'active', $3, 'offline-playlist')`, [randomUUID(), groupId, userId]), { code: '23505' });
    await assert.rejects(pool.query("UPDATE playlist_memberships SET external_playlist_id = NULL WHERE id = $1", [membershipId]), { code: '23514' });
    await assert.rejects(pool.query("INSERT INTO group_playlists (id, name, owner_id, invite_code) VALUES ($1, 'Duplicate', $2, 'invite')", [randomUUID(), userId]), { code: '23505' });
    const insertTrack = (isrc: string | null, key: string) => pool.query(`INSERT INTO canonical_tracks
      (id, isrc, normalized_title, normalized_artist, fallback_dedup_key, duration_ms)
      VALUES ($1, $2, 'other song', 'other artist', $3, 180000)`, [randomUUID(), isrc, key]);
    await assert.rejects(insertTrack('USAAA2300001', 'other'), { code: '23505' });
    await assert.rejects(insertTrack(null, 'test song|test artist|60'), { code: '23505' });
    await insertTrack(null, 'no-isrc-1');
    await insertTrack(null, 'no-isrc-2');
    const insertMapping = (storefront: string) => pool.query(`INSERT INTO track_provider_mappings
      (id, canonical_track_id, provider, storefront, external_track_id)
      VALUES ($1, $2, 'future_service', $3, 'external-1')`, [randomUUID(), trackId, storefront]);
    await insertMapping('us');
    await assert.rejects(insertMapping('us'), { code: '23505' });
    await insertMapping('gb');
    const insertConnection = () => pool.query(`INSERT INTO streaming_connections
      (id, user_id, provider, encrypted_access_token, storefront, status)
      VALUES ($1, $2, 'future_service', 'test-ciphertext', 'us', 'active')`, [randomUUID(), userId]);
    await insertConnection();
    await assert.rejects(insertConnection(), { code: '23505' });
    const insertItem = (id: string) => pool.query(`INSERT INTO playlist_items
      (id, group_playlist_id, canonical_track_id, added_by_user_id, position) VALUES ($1, $2, $3, $4, 0)`, [id, groupId, trackId, userId]);
    await insertItem(itemId);
    await assert.rejects(insertItem(randomUUID()), { code: '23505', constraint: 'idx_unique_active_track' });
    await pool.query('UPDATE playlist_items SET removed_at = now(), removed_by_user_id = $2 WHERE id = $1', [itemId, userId]);
    await insertItem(randomUUID());
    const insertEvent = (id: string, sequence: number) => pool.query(`INSERT INTO playlist_events
      (id, group_playlist_id, sequence_number, event_type, canonical_track_id, actor_user_id)
      VALUES ($1, $2, $3, 'TRACK_ADDED', $4, $5)`, [id, groupId, sequence, trackId, userId]);
    await insertEvent(eventId, 1);
    await assert.rejects(insertEvent(randomUUID(), 1), { code: '23505' });
    await assert.rejects(insertEvent(randomUUID(), 0), { code: '23514' });
    await assert.rejects(pool.query('UPDATE playlist_events SET sequence_number = 2 WHERE id = $1', [eventId]), { code: '23514' });
    await assert.rejects(pool.query('DELETE FROM playlist_events WHERE id = $1', [eventId]), { code: '23514' });
    const insertDelivery = () => pool.query(`INSERT INTO sync_delivery_logs
      (id, playlist_event_id, user_id, status) VALUES ($1, $2, $3, 'pending')`, [randomUUID(), eventId, userId]);
    await insertDelivery();
    await assert.rejects(insertDelivery(), { code: '23505' });
    await assert.rejects(pool.query('UPDATE playlist_memberships SET last_synced_sequence = -1 WHERE id = $1', [membershipId]), { code: '23514' });
    await assert.rejects(pool.query("UPDATE playlist_memberships SET status = 'invalid' WHERE id = $1", [membershipId]), { code: '23514' });
    await assert.rejects(pool.query('UPDATE sync_delivery_logs SET attempt_count = -1'), { code: '23514' });
    await assert.rejects(pool.query('UPDATE canonical_tracks SET duration_ms = -1 WHERE id = $1', [trackId]), { code: '23514' });
    await assert.rejects(pool.query('UPDATE group_playlists SET owner_id = $1 WHERE id = $2', [randomUUID(), groupId]), { code: '23503' });

    const errors: Error[] = [];
    queue = new JobQueue(databaseUrl.toString(), 2, error => { errors.push(error); });
    await queue.start();
    const queues = await pool.query('SELECT name, retry_limit, retry_delay, retry_backoff FROM pgboss.queue');
    assert.deepEqual(queues.rows.map(row => row.name).filter(name => queueNames.includes(name)).sort(), [...queueNames].sort());
    for (const row of queues.rows.filter(row => queueNames.includes(row.name))) {
      assert.equal(row.retry_limit, 5);
      assert.equal(row.retry_delay, 2);
      assert.equal(row.retry_backoff, true);
    }
    const received: unknown[] = [];
    await queue.register('fan-out-track-addition', async payload => { received.push(payload); });
    const payload = { eventId, groupPlaylistId: groupId, canonicalTrackId: trackId };
    assert.ok(await queue.send('fan-out-track-addition', payload));
    const deadline = Date.now() + 15000;
    while (!received.length && Date.now() < deadline) await delay(50);
    assert.deepEqual(received, [payload]);
    let attempts = 0;
    let retried = false;
    await queue.register('fan-out-track-removal', async () => {
      attempts += 1;
      if (attempts === 1) throw new Error('simulated transient failure');
      retried = true;
    });
    assert.ok(await queue.send('fan-out-track-removal', payload));
    const retryDeadline = Date.now() + 20000;
    while (!retried && Date.now() < retryDeadline) await delay(50);
    assert.ok(retried, 'failed jobs must be retried');
    assert.equal(attempts, 2);
    assert.deepEqual(errors, []);
  } finally {
    try { await queue?.stop(); } finally {
      await pool.end();
      try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`); }
      finally { await admin.end(); }
    }
  }
});
