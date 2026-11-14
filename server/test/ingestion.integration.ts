import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { JobQueue } from '../src/jobs/queue.js';
import { PlaylistIngestionService } from '../src/services/PlaylistIngestionService.js';
import { createApi } from '../src/api/server.js';
import { createSessionVerifier } from '../src/api/auth.js';
import type { TrackMetadata } from '../src/domain/TrackCanonicalizer.js';

test('ingestion is authorized, canonical, concurrent, monotonic and transactionally queued', { timeout: 60000 }, async () => {
  const adminUrl = process.env.TEST_DATABASE_URL;
  assert.ok(adminUrl, 'TEST_DATABASE_URL is required');
  const admin = createPool(adminUrl);
  const databaseName = `baton_ingestion_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const pool = createPool(databaseUrl.toString());
  const queueErrors: Error[] = [];
  const queue = new JobQueue(databaseUrl.toString(), 2, error => { queueErrors.push(error); });
  let created = false;
  let started = false;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(pool);
    await queue.start();
    started = true;
    const ownerId = randomUUID();
    const memberId = randomUUID();
    const outsiderId = randomUUID();
    const playlistId = randomUUID();
    const secondPlaylistId = randomUUID();
    for (const userId of [ownerId, memberId, outsiderId]) {
      await pool.query('INSERT INTO users (id, apple_sub, display_name) VALUES ($1, $2, $2)', [userId, userId]);
    }
    for (const groupId of [playlistId, secondPlaylistId]) {
      await pool.query('INSERT INTO group_playlists (id, name, owner_id, invite_code) VALUES ($1, $2, $3, $2)', [groupId, groupId, ownerId]);
      for (const userId of [ownerId, memberId]) {
        await pool.query("INSERT INTO playlist_memberships (id, group_playlist_id, user_id, status) VALUES ($1, $2, $3, 'active')", [randomUUID(), groupId, userId]);
      }
    }
    const fixtures = new Map<string, TrackMetadata>();
    let metadataCalls = 0;
    const service = new PlaylistIngestionService(pool, { async resolve(link) {
      metadataCalls += 1;
      const value = fixtures.get(link.externalTrackId);
      assert.ok(value, `Missing offline fixture: ${link.externalTrackId}`);
      return value;
    } }, queue);
    const song = (title: string, durationMs = 180000, isrc: string | null = null): TrackMetadata => ({ title, artist: 'Beyoncé', album: 'Album', durationMs, isrc });
    const url = (identifier: string, storefront = 'us') => `https://music.apple.com/${storefront}/song/${identifier}`;
    fixtures.set('100', song('First Song'));
    const additions = await Promise.all(Array.from({ length: 12 }, (_, index) => service.add(playlistId, index % 2 ? ownerId : memberId, url('100'))));
    assert.equal(additions.filter(result => result.status === 202).length, 1);
    assert.equal(additions.filter(result => result.status === 200).length, 11);
    assert.equal(new Set(additions.map(result => result.canonicalTrackId)).size, 1);
    const beforeCache = metadataCalls;
    assert.equal((await service.add(playlistId, ownerId, url('100'))).status, 200);
    assert.equal(metadataCalls, beforeCache, 'provider mapping cache should skip metadata network calls');

    fixtures.set('200', song('ISRC Original', 180000, 'USAAA2300001'));
    const original = await service.add(playlistId, ownerId, url('200'));
    const spotifyId = '4cOdK2wGLETKBW3PvgPWqT';
    fixtures.set(spotifyId, { ...song('Completely Different Label', 190000, 'USAAA2300001'), artist: 'Other spelling' });
    const byIsrc = await service.add(playlistId, memberId, `spotify:track:${spotifyId}`);
    assert.equal(byIsrc.status, 200);
    assert.equal(byIsrc.canonicalTrackId, original.canonicalTrackId);
    fixtures.set('201', song('ISRC Original', 180000, 'USAAA2300002'));
    const differentRecording = await service.add(playlistId, ownerId, url('201'));
    assert.equal(differentRecording.status, 202);
    assert.notEqual(differentRecording.canonicalTrackId, original.canonicalTrackId);
    fixtures.set('202', song('ISRC Original'));
    await assert.rejects(service.add(playlistId, ownerId, url('202')), { code: 'ambiguous_recording' });

    fixtures.set('300', song('Déjà Vu (feat. Guest)', 181499));
    const boundary = await service.add(playlistId, ownerId, url('300'));
    for (const [identifier, durationMs] of [['301', 181501], ['302', 184499], ['303', 178499]] as const) {
      fixtures.set(identifier, { ...song('Deja Vu [Deluxe Edition]', durationMs), artist: 'Beyonce' });
      const result = await service.add(playlistId, memberId, url(identifier, 'gb'));
      assert.equal(result.status, 200);
      assert.equal(result.canonicalTrackId, boundary.canonicalTrackId);
    }
    fixtures.set('304', song('Deja Vu', 184500));
    assert.equal((await service.add(playlistId, ownerId, url('304'))).status, 202);
    fixtures.set('305', song('Deja Vu', 178498));
    assert.equal((await service.add(playlistId, ownerId, url('305'))).status, 202);

    fixtures.set('400', song('Later Enriched'));
    const withoutIsrc = await service.add(playlistId, ownerId, url('400'));
    fixtures.set('401', song('Later Enriched', 181000, 'USAAA2300003'));
    assert.equal((await service.add(playlistId, ownerId, url('401'))).canonicalTrackId, withoutIsrc.canonicalTrackId);
    assert.equal((await pool.query('SELECT isrc FROM canonical_tracks WHERE id = $1', [withoutIsrc.canonicalTrackId])).rows[0].isrc, 'USAAA2300003');

    const deniedBefore = metadataCalls;
    await assert.rejects(service.add(playlistId, outsiderId, url('100')), { status: 403 });
    for (const status of ['invited', 'provisioning', 'recreating', 'paused', 'removed']) {
      await pool.query('UPDATE playlist_memberships SET status = $1 WHERE group_playlist_id = $2 AND user_id = $3', [status, playlistId, memberId]);
      await assert.rejects(service.add(playlistId, memberId, url('100')), { status: 403 });
    }
    assert.equal(metadataCalls, deniedBefore);
    await pool.query("UPDATE playlist_memberships SET status = 'active' WHERE group_playlist_id = $1 AND user_id = $2", [playlistId, memberId]);
    let revokeDuringResolution = true;
    const revoked = new PlaylistIngestionService(pool, { async resolve() {
      if (revokeDuringResolution) {
        await pool.query("UPDATE playlist_memberships SET status = 'removed' WHERE group_playlist_id = $1 AND user_id = $2", [playlistId, memberId]);
        revokeDuringResolution = false;
      }
      return song('Membership Revoked');
    } }, queue);
    await assert.rejects(revoked.add(playlistId, memberId, url('999')), { status: 403 });

    const counts = async () => ({
      sequence: (await pool.query('SELECT current_sequence FROM group_playlists WHERE id = $1', [playlistId])).rows[0].current_sequence as number,
      events: (await pool.query('SELECT count(*) FROM playlist_events')).rows[0].count,
      items: (await pool.query('SELECT count(*) FROM playlist_items')).rows[0].count,
      tracks: (await pool.query('SELECT count(*) FROM canonical_tracks')).rows[0].count,
      mappings: (await pool.query('SELECT count(*) FROM track_provider_mappings')).rows[0].count,
      jobs: (await pool.query("SELECT count(*) FROM pgboss.job WHERE name = 'fan-out-track-addition'")).rows[0].count,
    });
    const beforeRollback = await counts();
    const failing = new PlaylistIngestionService(pool, { async resolve() { return song('Queue Rollback'); } }, {
      async sendInTransaction(client, name, payload) {
        await queue.sendInTransaction(client, name, payload);
        throw new Error('simulated failure after queued insert');
      },
    });
    await assert.rejects(failing.add(playlistId, ownerId, url('600')), /simulated failure/);
    assert.deepEqual(await counts(), beforeRollback, 'all catalog, playlist, event, and job changes must roll back');

    fixtures.set('700', song('Global concurrent', 180000, 'USAAA2300004'));
    fixtures.set('701', song('Global concurrent renamed', 182000, 'USAAA2300004'));
    const global = await Promise.all([
      service.add(playlistId, ownerId, url('700')),
      service.add(secondPlaylistId, ownerId, url('701', 'jp')),
    ]);
    assert.equal(global[0]!.canonicalTrackId, global[1]!.canonicalTrackId);
    const beforeConcurrent = (await counts()).sequence;
    const distinct = await Promise.all(Array.from({ length: 12 }, (_, index) => {
      const identifier = `${800 + index}`;
      fixtures.set(identifier, song(`Distinct ${index}`));
      return service.add(playlistId, ownerId, url(identifier));
    }));
    assert.deepEqual(distinct.map(result => result.event!.sequenceNumber).sort((left, right) => left - right),
      Array.from({ length: 12 }, (_, index) => beforeConcurrent + index + 1));
    const final = await counts();
    assert.equal(final.events, final.jobs);
    const emitted = await pool.query('SELECT sequence_number FROM playlist_events WHERE group_playlist_id = $1 ORDER BY sequence_number', [playlistId]);
    assert.deepEqual(emitted.rows.map(row => row.sequence_number), Array.from({ length: final.sequence }, (_, index) => index + 1));
    const orphaned = await pool.query(`SELECT id FROM pgboss.job WHERE name = 'fan-out-track-addition'
      AND NOT EXISTS (SELECT 1 FROM playlist_events WHERE id = (data->>'eventId')::uuid)`);
    assert.equal(orphaned.rowCount, 0);

    const session = { secret: 'integration-only-secret-at-least-32-bytes', issuer: 'baton', audience: 'baton-api' };
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'HS256' }).setSubject(ownerId)
      .setIssuer(session.issuer).setAudience(session.audience).setIssuedAt().setExpirationTime('15m')
      .sign(new TextEncoder().encode(session.secret));
    const api = createApi(async () => { await pool.query('SELECT 1'); }, {
      authenticate: createSessionVerifier(session), add: (groupId, userId, rawInput) => service.add(groupId, userId, rawInput),
    });
    api.listen(0, '127.0.0.1');
    await once(api, 'listening');
    try {
      const address = api.address();
      assert.ok(address && typeof address !== 'string');
      const endpoint = `http://127.0.0.1:${address.port}/api/playlists/${playlistId}/items`;
      const headers = { authorization: `Bearer ${token}`, 'content-type': 'application/json' };
      fixtures.set('950', song('Via HTTP'));
      const accepted = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ rawInput: url('950') }) });
      assert.equal(accepted.status, 202);
      const body = await accepted.json() as { event: { actorUserId: string } };
      assert.equal(body.event.actorUserId, ownerId);
      assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ rawInput: url('950') }) })).status, 200);
      assert.equal((await fetch(endpoint, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ rawInput: url('950') }) })).status, 401);
      const forged = await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ rawInput: url('950'), userId: outsiderId }) });
      assert.equal(forged.status, 400);
      assert.equal((await fetch(endpoint, { method: 'POST', headers, body: JSON.stringify({ rawInput: 'not a link' }) })).status, 422);
    } finally { await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve())); }
    assert.deepEqual(queueErrors, []);
  } finally {
    try { if (started) await queue.stop(); } finally {
      await pool.end();
      try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`); }
      finally { await admin.end(); }
    }
  }
});
