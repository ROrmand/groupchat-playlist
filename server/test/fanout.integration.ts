import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { JobQueue } from '../src/jobs/queue.js';
import { ProviderRegistry, ProviderSyncError, type StreamingProviderAdapter } from '../src/providers/StreamingProviderAdapter.js';
import { TokenVault } from '../src/services/TokenVault.js';
import { FanOutPlanner } from '../src/services/FanOutPlanner.js';
import { FanOutWorker } from '../src/services/FanOutWorker.js';

function adapter(providerId: string, overrides: Partial<StreamingProviderAdapter> = {}): StreamingProviderAdapter {
  return {
    providerId, capabilities: { supportsISRC: true, supportsServerSideDelete: true, supportsBatchAppend: true,
      maxTracksPerRequest: 100, tokenRefreshMode: 'server_oauth' },
    async createPlaylist() { return 'playlist'; },
    async resolveTrackId(_connection, track) { return `${track.normalizedTitle}-id`; },
    async appendTracks(_connection, _playlist, trackIds) { return trackIds.map(trackId => ({ trackId, handle: `${trackId}-handle` })); },
    async removeTracks() {},
    ...overrides,
  };
}

test('fan-out delivery, isolation, ordering, retries and uncertain-write recovery use offline providers', { timeout: 60000 }, async context => {
  const adminUrl = process.env.TEST_DATABASE_URL;
  assert.ok(adminUrl, 'TEST_DATABASE_URL is required');
  const admin = createPool(adminUrl);
  const databaseName = `baton_fanout_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const pool = createPool(databaseUrl.toString());
  const queueErrors: Error[] = [];
  const queue = new JobQueue(databaseUrl.toString(), 2, error => queueErrors.push(error));
  const vault = new TokenVault(Buffer.alloc(32, 7).toString('base64'));
  let started = false;
  let created = false;
  const ownerId = randomUUID();
  const group = async () => {
    const id = randomUUID();
    await pool.query('INSERT INTO group_playlists (id, name, owner_id, invite_code) VALUES ($1::uuid, $1::text, $2, $1::text)', [id, ownerId]);
    return id;
  };
  const member = async (groupId: string, provider: string, token = 'access', storefront = 'us') => {
    const userId = randomUUID();
    const membershipId = randomUUID();
    const connectionId = randomUUID();
    await pool.query('INSERT INTO users (id, apple_sub, display_name) VALUES ($1::uuid, $1::text, $1::text)', [userId]);
    await pool.query(`INSERT INTO streaming_connections (id, user_id, provider, encrypted_access_token, encrypted_refresh_token, storefront, status)
      VALUES ($1, $2, $3, $4, $5, $6, 'active')`, [connectionId, userId, provider, vault.encrypt(token, connectionId), vault.encrypt('refresh', connectionId), storefront]);
    await pool.query(`INSERT INTO playlist_memberships (id, group_playlist_id, user_id, status, external_playlist_id, streaming_connection_id)
      VALUES ($1, $2, $3, 'active', $4, $5)`, [membershipId, groupId, userId, `playlist-${membershipId}`, connectionId]);
    return { userId, membershipId, connectionId };
  };
  const event = async (groupId: string, title: string, type = 'TRACK_ADDED', existingTrack?: string) => {
    const trackId = existingTrack ?? randomUUID();
    if (!existingTrack) await pool.query(`INSERT INTO canonical_tracks (id, normalized_title, normalized_artist, fallback_dedup_key, duration_ms)
      VALUES ($1::uuid, $2, 'artist', $1::text, 180000)`, [trackId, title]);
    const sequence = (await pool.query('UPDATE group_playlists SET current_sequence = current_sequence + 1 WHERE id = $1 RETURNING current_sequence', [groupId])).rows[0].current_sequence as number;
    const id = randomUUID();
    await pool.query(`INSERT INTO playlist_events (id, group_playlist_id, sequence_number, event_type, canonical_track_id, actor_user_id)
      VALUES ($1, $2, $3, $4, $5, $6)`, [id, groupId, sequence, type, trackId, ownerId]);
    return { id, sequence, trackId };
  };
  const cursor = async (membershipId: string) => (await pool.query('SELECT last_synced_sequence FROM playlist_memberships WHERE id = $1', [membershipId])).rows[0].last_synced_sequence as number;
  const log = async (eventId: string, userId: string) => (await pool.query('SELECT * FROM sync_delivery_logs WHERE playlist_event_id = $1 AND user_id = $2', [eventId, userId])).rows[0]!;
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(pool);
    await queue.start();
    started = true;
    await pool.query('INSERT INTO users (id, apple_sub, display_name) VALUES ($1::uuid, $1::text, $1::text)', [ownerId]);

    await context.test('out-of-order and concurrent jobs drain contiguous events once and planner targets only active selected connections', async () => {
      const groupId = await group();
      const selected = await member(groupId, 'test');
      const paused = await member(groupId, 'test');
      await pool.query("UPDATE playlist_memberships SET status = 'paused' WHERE id = $1", [paused.membershipId]);
      const disconnected = await member(groupId, 'test');
      await pool.query("UPDATE streaming_connections SET status = 'needs_reauth' WHERE id = $1", [disconnected.connectionId]);
      const calls: string[] = [];
      let resolutions = 0;
      const provider = adapter('test', {
        async resolveTrackId(_connection, track) { resolutions += 1; return `${track.normalizedTitle}-id`; },
        async appendTracks(_connection, _playlist, tracks) { calls.push(...tracks); return tracks.map(trackId => ({ trackId, handle: trackId })); },
      });
      const worker = new FanOutWorker(pool, queue, new ProviderRegistry().register(provider), vault);
      await event(groupId, 'first');
      const latest = await event(groupId, 'second');
      await new FanOutPlanner(pool, queue).plan(latest.id);
      assert.equal((await pool.query('SELECT count(*) FROM sync_delivery_logs WHERE playlist_event_id = $1', [latest.id])).rows[0].count, '1');
      await Promise.allSettled([worker.deliver(selected.membershipId, 2), worker.deliver(selected.membershipId, 2)]);
      await worker.deliver(selected.membershipId, 2);
      await worker.deliver(selected.membershipId, 1);
      assert.deepEqual(calls, ['first-id', 'second-id']);
      assert.equal(await cursor(selected.membershipId), 2);
      assert.equal(resolutions, 2);
      assert.equal(await cursor(paused.membershipId), 0);
      await assert.rejects(pool.query('UPDATE playlist_memberships SET last_synced_sequence = 1 WHERE id = $1', [selected.membershipId]), { code: '23514' });
      await assert.rejects(pool.query('UPDATE playlist_memberships SET streaming_connection_id = $2 WHERE id = $1', [selected.membershipId, paused.connectionId]), { code: '23503' });
    });

    await context.test('rate limits, unavailable tracks and expired Apple tokens do not block other members', async () => {
      const groupId = await group();
      const healthy = await member(groupId, 'mixed', 'healthy');
      const limited = await member(groupId, 'mixed', 'limited');
      const unavailable = await member(groupId, 'mixed', 'unavailable', 'gb');
      const expired = await member(groupId, 'apple_music', 'expired');
      let rateLimit = true;
      const mixed = adapter('mixed', {
        async resolveTrackId(connection, track) { return connection.accessToken === 'unavailable' ? null : `${track.normalizedTitle}-resolved`; },
        async appendTracks(connection, _playlist, tracks) {
          if (connection.accessToken === 'limited' && rateLimit) throw new ProviderSyncError('RATE_LIMITED', 120);
          return tracks.map(trackId => ({ trackId, handle: trackId }));
        },
      });
      const apple = adapter('apple_music', { async resolveTrackId() { throw new ProviderSyncError('TOKEN_EXPIRED'); } });
      const worker = new FanOutWorker(pool, queue, new ProviderRegistry().register(mixed).register(apple), vault);
      const addition = await event(groupId, 'isolated');
      for (const target of [limited, healthy, expired, unavailable]) await worker.deliver(target.membershipId, 1);
      assert.equal(await cursor(healthy.membershipId), 1);
      assert.equal(await cursor(unavailable.membershipId), 1);
      assert.equal((await log(addition.id, unavailable.userId)).status, 'skipped_unavailable');
      const retry = await log(addition.id, limited.userId);
      assert.equal(retry.status, 'failed_retryable');
      assert.ok(retry.next_attempt_at.getTime() > Date.now() + 110000);
      assert.equal(await cursor(limited.membershipId), 0);
      assert.equal((await pool.query('SELECT status FROM streaming_connections WHERE id = $1', [expired.connectionId])).rows[0].status, 'needs_reauth');
      await event(groupId, 'later');
      await worker.deliver(limited.membershipId, 2);
      assert.equal(await cursor(limited.membershipId), 0);
      rateLimit = false;
      await pool.query('UPDATE sync_delivery_logs SET next_attempt_at = now() WHERE id = $1', [retry.id]);
      await worker.deliver(limited.membershipId, 1);
      assert.equal(await cursor(limited.membershipId), 2);
      assert.equal((await log(addition.id, limited.userId)).attempt_count, 2);
    });

    await context.test('ambiguous writes and abandoned delivering claims require reconciliation and never replay', async () => {
      const groupId = await group();
      const target = await member(groupId, 'uncertain');
      let calls = 0;
      const provider = adapter('uncertain', { async appendTracks() { calls += 1; throw new ProviderSyncError('AMBIGUOUS_WRITE'); } });
      const worker = new FanOutWorker(pool, queue, new ProviderRegistry().register(provider), vault);
      const addition = await event(groupId, 'unknown');
      await worker.deliver(target.membershipId, 1);
      await worker.deliver(target.membershipId, 1);
      assert.equal(calls, 1);
      assert.equal((await log(addition.id, target.userId)).status, 'needs_reconcile');
      assert.equal(await cursor(target.membershipId), 0);
      const crashTarget = await member(groupId, 'uncertain');
      await pool.query(`INSERT INTO sync_delivery_logs (id, playlist_event_id, user_id, status)
        VALUES ($1, $2, $3, 'delivering')`, [randomUUID(), addition.id, crashTarget.userId]);
      await worker.deliver(crashTarget.membershipId, 1);
      assert.equal(calls, 1);
      assert.equal((await log(addition.id, crashTarget.userId)).status, 'needs_reconcile');
    });

    await context.test('YouTube removal uses stored handles; Apple removal waits for client reconciliation', async () => {
      const groupId = await group();
      const youtube = await member(groupId, 'youtube_music');
      const apple = await member(groupId, 'apple_music');
      const removed: string[] = [];
      const youtubeProvider = adapter('youtube_music', {
        async appendTracks(_connection, _playlist, tracks) { return tracks.map(trackId => ({ trackId, handle: 'youtube-item-handle' })); },
        async removeTracks(_connection, _playlist, handles) { removed.push(...handles.map(handle => handle.handle)); },
      });
      const appleProvider = adapter('apple_music', { capabilities: { supportsISRC: true, supportsServerSideDelete: false,
        supportsBatchAppend: true, maxTracksPerRequest: 100, tokenRefreshMode: 'on_device_sdk' } });
      const worker = new FanOutWorker(pool, queue, new ProviderRegistry().register(youtubeProvider).register(appleProvider), vault);
      const addition = await event(groupId, 'removable');
      const removal = await event(groupId, 'removable', 'TRACK_REMOVED', addition.trackId);
      await worker.deliver(youtube.membershipId, 2);
      await worker.deliver(apple.membershipId, 2);
      assert.deepEqual(removed, ['youtube-item-handle']);
      assert.equal((await log(addition.id, youtube.userId)).provider_item_handle, 'youtube-item-handle');
      assert.equal(await cursor(youtube.membershipId), 2);
      assert.equal(await cursor(apple.membershipId), 1);
      assert.equal((await log(removal.id, apple.userId)).status, 'pending_client_reconcile');
    });

    await context.test('OAuth refresh rotates encrypted credentials and retries a rejected call only once', async () => {
      const groupId = await group();
      const target = await member(groupId, 'oauth', 'expired');
      let refreshes = 0;
      const provider = adapter('oauth', {
        async resolveTrackId(connection) {
          if (connection.accessToken === 'expired') throw new ProviderSyncError('TOKEN_EXPIRED');
          return 'refreshed-track';
        },
        async refreshToken() { refreshes += 1; return { accessToken: 'renewed', refreshToken: 'rotated', expiresIn: 3600 }; },
      });
      const worker = new FanOutWorker(pool, queue, new ProviderRegistry().register(provider), vault);
      await event(groupId, 'refresh');
      await worker.deliver(target.membershipId, 1);
      const stored = (await pool.query('SELECT * FROM streaming_connections WHERE id = $1', [target.connectionId])).rows[0];
      assert.equal(vault.decrypt(stored.encrypted_access_token, target.connectionId), 'renewed');
      assert.equal(vault.decrypt(stored.encrypted_refresh_token, target.connectionId), 'rotated');
      assert.equal(refreshes, 1);
      assert.equal(await cursor(target.membershipId), 1);
    });

    await context.test('membership revocation during resolution prevents the subsequent provider write', async () => {
      const groupId = await group();
      const target = await member(groupId, 'revocation');
      let writes = 0;
      const provider = adapter('revocation', {
        async resolveTrackId() {
          await pool.query("UPDATE playlist_memberships SET status = 'removed' WHERE id = $1", [target.membershipId]);
          return 'resolved';
        },
        async appendTracks() { writes += 1; return []; },
      });
      await event(groupId, 'revoked');
      await new FanOutWorker(pool, queue, new ProviderRegistry().register(provider), vault).deliver(target.membershipId, 1);
      assert.equal(writes, 0);
      assert.equal(await cursor(target.membershipId), 0);
    });

    await context.test('missing downstream playlists transition membership and enqueue recreation', async () => {
      const groupId = await group();
      const target = await member(groupId, 'missing');
      const provider = adapter('missing', { async appendTracks() { throw new ProviderSyncError('PLAYLIST_NOT_FOUND'); } });
      await event(groupId, 'missing');
      await new FanOutWorker(pool, queue, new ProviderRegistry().register(provider), vault).deliver(target.membershipId, 1);
      assert.equal((await pool.query('SELECT status FROM playlist_memberships WHERE id = $1', [target.membershipId])).rows[0].status, 'recreating');
      assert.equal((await pool.query("SELECT count(*) FROM pgboss.job WHERE name = 'recreate-playlist' AND data->>'membershipId' = $1", [target.membershipId])).rows[0].count, '1');
      assert.equal(await cursor(target.membershipId), 0);
    });

    await context.test('provider mapping cache is reused within a storefront but not across storefronts', async () => {
      const groupId = await group();
      const first = await member(groupId, 'regional', 'access', 'us');
      const second = await member(groupId, 'regional', 'access', 'us');
      const foreign = await member(groupId, 'regional', 'access', 'gb');
      const resolutions: string[] = [];
      const provider = adapter('regional', { async resolveTrackId(_connection, _track, storefront) {
        resolutions.push(storefront);
        return `${storefront}-track`;
      } });
      const addition = await event(groupId, 'regional');
      const worker = new FanOutWorker(pool, queue, new ProviderRegistry().register(provider), vault);
      for (const target of [first, second, foreign]) await worker.deliver(target.membershipId, 1);
      assert.deepEqual(resolutions, ['us', 'gb']);
      assert.equal((await pool.query('SELECT count(*) FROM track_provider_mappings WHERE canonical_track_id = $1', [addition.trackId])).rows[0].count, '2');
    });

    await context.test('safe retries stop after five attempts without advancing over failure', async () => {
      const groupId = await group();
      const target = await member(groupId, 'retry');
      let attempts = 0;
      const provider = adapter('retry', { async resolveTrackId() { attempts += 1; throw new ProviderSyncError('TRANSIENT'); } });
      const addition = await event(groupId, 'retry');
      const worker = new FanOutWorker(pool, queue, new ProviderRegistry().register(provider), vault);
      for (let attempt = 0; attempt < 6; attempt += 1) {
        await pool.query('UPDATE sync_delivery_logs SET next_attempt_at = now() WHERE playlist_event_id = $1', [addition.id]);
        await worker.deliver(target.membershipId, 1);
      }
      assert.equal(attempts, 5);
      assert.equal((await log(addition.id, target.userId)).status, 'failed_terminal');
      assert.equal((await log(addition.id, target.userId)).attempt_count, 5);
      assert.equal(await cursor(target.membershipId), 0);
    });

    await context.test('repeated unauthorized writes refresh once then require reauthorization', async () => {
      const groupId = await group();
      const target = await member(groupId, 'rejected');
      let writes = 0;
      let refreshes = 0;
      const provider = adapter('rejected', {
        async appendTracks() { writes += 1; throw new ProviderSyncError('TOKEN_EXPIRED'); },
        async refreshToken() { refreshes += 1; return { accessToken: 'new', refreshToken: 'new-refresh', expiresIn: 3600 }; },
      });
      await event(groupId, 'unauthorized');
      await new FanOutWorker(pool, queue, new ProviderRegistry().register(provider), vault).deliver(target.membershipId, 1);
      assert.equal(writes, 2);
      assert.equal(refreshes, 1);
      assert.equal((await pool.query('SELECT status FROM streaming_connections WHERE id = $1', [target.connectionId])).rows[0].status, 'needs_reauth');
      assert.equal(await cursor(target.membershipId), 0);
    });

    await context.test('registered pg-boss handlers deliver a queued event end to end', async () => {
      await pool.query('DELETE FROM pgboss.job');
      const groupId = await group();
      const target = await member(groupId, 'pipeline');
      let writes = 0;
      const provider = adapter('pipeline', { async appendTracks(_connection, _playlist, tracks) {
        writes += 1;
        return tracks.map(trackId => ({ trackId, handle: 'pipeline-handle' }));
      } });
      const planner = new FanOutPlanner(pool, queue);
      const worker = new FanOutWorker(pool, queue, new ProviderRegistry().register(provider), vault);
      await queue.register('fan-out-track-addition', payload => planner.plan(payload.eventId));
      await queue.register('deliver-membership', payload => worker.deliver(payload.membershipId, payload.throughSequence));
      const addition = await event(groupId, 'pipeline');
      await queue.send('fan-out-track-addition', { eventId: addition.id, groupPlaylistId: groupId, canonicalTrackId: addition.trackId });
      const deadline = Date.now() + 15000;
      while (await cursor(target.membershipId) !== 1 && Date.now() < deadline) await delay(50);
      assert.equal(await cursor(target.membershipId), 1);
      assert.equal(writes, 1);
      assert.equal((await log(addition.id, target.userId)).provider_item_handle, 'pipeline-handle');
    });
    assert.deepEqual(queueErrors, []);
  } finally {
    try { if (started) await queue.stop(); } finally {
      await pool.end();
      try { if (created) await admin.query(`DROP DATABASE "${databaseName}"`); }
      finally { await admin.end(); }
    }
  }
});
