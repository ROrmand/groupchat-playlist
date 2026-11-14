import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { createApi } from '../src/api/server.js';
import { createPool } from '../src/db/pool.js';
import { migrate } from '../src/db/migrate.js';
import { JobQueue } from '../src/jobs/queue.js';
import type { ConnectionAuthorizer } from '../src/providers/AuthorizationProvider.js';
import { ProviderRegistry, ProviderSyncError, type StreamingProviderAdapter } from '../src/providers/StreamingProviderAdapter.js';
import { ConnectionService } from '../src/services/ConnectionService.js';
import { FanOutPlanner } from '../src/services/FanOutPlanner.js';
import { FanOutWorker } from '../src/services/FanOutWorker.js';
import { GroupService } from '../src/services/GroupService.js';
import { ProvisioningService } from '../src/services/ProvisioningService.js';
import { SessionService } from '../src/services/SessionService.js';
import { TokenVault } from '../src/services/TokenVault.js';
import { digest } from '../src/services/onboardingSupport.js';

test('Sprint 4 identity, connections, invitations, provisioning and live fan-out work offline', { timeout: 60000 }, async context => {
  const adminUrl = process.env.TEST_DATABASE_URL;
  assert.ok(adminUrl, 'TEST_DATABASE_URL is required');
  const admin = createPool(adminUrl);
  const databaseName = `baton_onboarding_${randomUUID().replaceAll('-', '')}`;
  const databaseUrl = new URL(adminUrl);
  databaseUrl.pathname = `/${databaseName}`;
  const pool = createPool(databaseUrl.toString());
  const queue = new JobQueue(databaseUrl.toString(), 2, error => { throw error; });
  const vault = new TokenVault(Buffer.alloc(32, 9).toString('base64'));
  const sessions = new SessionService(pool, { secret: 'session-secret-'.repeat(4), issuer: 'baton', audience: 'baton-api' }, {
    async verify(code, nonce) { assert.ok(nonce); if (code === 'invalid') throw new Error('private-provider-error'); return code; },
  });
  let accountId = 'account';
  let exchangeCount = 0;
  const authorizer: ConnectionAuthorizer = {
    begin(provider, state, verifier) { assert.ok(verifier); return `https://provider.example/${provider}?state=${state}`; },
    async exchange(_provider, code, verifier) {
      exchangeCount += 1;
      assert.equal(verifier.length, 43);
      if (code === 'reject') throw new Error('private-provider-error');
      return { accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 3600, storefront: 'us', accountId };
    },
    async apple(token) { if (token === 'invalid') throw new Error('private-provider-error'); return 'gb'; },
  };
  const connections = new ConnectionService(pool, vault, authorizer, new Set(['https://baton.example/connected']));
  const groups = new GroupService(pool, vault);
  let creates = 0;
  let createBehavior: (() => Promise<string>) | undefined;
  const writes: string[] = [];
  const adapter: StreamingProviderAdapter = {
    providerId: 'spotify', capabilities: { supportsISRC: true, supportsServerSideDelete: true, supportsBatchAppend: true,
      maxTracksPerRequest: 100, tokenRefreshMode: 'server_oauth' },
    async createPlaylist() { creates += 1; return createBehavior ? createBehavior() : `external-${creates}`; },
    async resolveTrackId(_connection, track) { return track.id; },
    async appendTracks(_connection, _playlist, tracks) { writes.push(...tracks); return tracks.map(trackId => ({ trackId, handle: trackId })); },
    async refreshToken() { return { accessToken: 'rotated-access', refreshToken: 'rotated-refresh', expiresIn: 3600 }; },
  };
  const registry = new ProviderRegistry().register(adapter).register({ ...adapter, providerId: 'apple_music',
    capabilities: { ...adapter.capabilities, tokenRefreshMode: 'on_device_sdk' } });
  const provisioning = new ProvisioningService(pool, queue, registry, vault);
  const api = createApi(async () => { await pool.query('SELECT 1'); }, undefined, { sessions, connections, groups, provisioning });
  let created = false;
  let started = false;
  const login = async (subject: string = randomUUID()) => { const challenge = await sessions.challenge(); return sessions.signIn(subject, challenge.challenge); };
  const connect = async (userId: string) => {
    const begun = await connections.begin(userId, 'spotify', 'https://baton.example/connected');
    const state = new URL(begun.authorizationUrl).searchParams.get('state')!;
    return connections.complete('spotify', state, 'code');
  };
  const setup = async () => {
    const user = await login();
    const connection = await connect(user.userId);
    const group = await groups.create(user.userId, 'Test playlist', randomUUID());
    const request = await provisioning.start(user.userId, group.membershipId, connection.connectionId, randomUUID());
    return { user, connection, group, attemptId: request.attemptId };
  };
  const attempt = async (attemptId: string) => (await pool.query('SELECT * FROM provisioning_attempts WHERE id = $1', [attemptId])).rows[0]!;
  const event = async (groupId: string, userId: string) => {
    const trackId = randomUUID();
    const eventId = randomUUID();
    await pool.query(`INSERT INTO canonical_tracks (id, normalized_title, normalized_artist, fallback_dedup_key, duration_ms)
      VALUES ($1::uuid, 'song', 'artist', $1::text, 180000)`, [trackId]);
    const sequence = (await pool.query('UPDATE group_playlists SET current_sequence = current_sequence + 1 WHERE id = $1 RETURNING current_sequence', [groupId])).rows[0]!.current_sequence as number;
    await pool.query(`INSERT INTO playlist_events (id, group_playlist_id, sequence_number, event_type, canonical_track_id, actor_user_id)
      VALUES ($1, $2, $3, 'TRACK_ADDED', $4, $5)`, [eventId, groupId, sequence, trackId, userId]);
    return { eventId, trackId, sequence };
  };
  try {
    await admin.query(`CREATE DATABASE "${databaseName}"`);
    created = true;
    await migrate(pool);
    await queue.start();
    started = true;

    await context.test('single-use challenges, stable identity, refresh replay, concurrent rotation and revocation', async () => {
      const challenge = await sessions.challenge();
      const first = await sessions.signIn('same-apple-sub', challenge.challenge);
      await assert.rejects(sessions.signIn('same-apple-sub', challenge.challenge), { code: 'invalid_challenge' });
      assert.equal((await login('same-apple-sub')).userId, first.userId);
      assert.equal(await sessions.authenticate(`Bearer ${first.accessToken}`), first.userId);
      const rotated = await sessions.refresh(first.refreshToken);
      await assert.rejects(sessions.refresh(first.refreshToken), { code: 'invalid_refresh_token' });
      await assert.rejects(sessions.authenticate(`Bearer ${rotated.accessToken}`), { code: 'invalid_session' });
      const concurrent = await login();
      const results = await Promise.allSettled([sessions.refresh(concurrent.refreshToken), sessions.refresh(concurrent.refreshToken)]);
      assert.equal(results.filter(result => result.status === 'fulfilled').length, 1);
      await assert.rejects(sessions.authenticate(`Bearer ${concurrent.accessToken}`), { code: 'invalid_session' });
      const logout = await login();
      await sessions.logout(`Bearer ${logout.accessToken}`, false);
      await assert.rejects(sessions.refresh(logout.refreshToken), { code: 'invalid_refresh_token' });
      const firstSession = await login('all-sessions');
      const secondSession = await login('all-sessions');
      await sessions.logout(`Bearer ${firstSession.accessToken}`, true);
      await assert.rejects(sessions.authenticate(`Bearer ${secondSession.accessToken}`), { code: 'invalid_session' });
      const expired = await sessions.challenge();
      await pool.query('UPDATE auth_challenges SET expires_at = now() - interval \'1 second\' WHERE secret_hash = $1', [digest(expired.challenge)]);
      await assert.rejects(sessions.signIn('sub', expired.challenge), { code: 'invalid_challenge' });
      const data = JSON.stringify((await pool.query('SELECT * FROM session_refresh_tokens')).rows);
      assert.ok(!data.includes(first.refreshToken));
    });

    await context.test('OAuth state is expiring, single-use, provider/user bound; credentials stay encrypted', async () => {
      const user = await login();
      await assert.rejects(connections.begin(user.userId, 'spotify', 'https://evil.example'), { code: 'invalid_return_target' });
      const begun = await connections.begin(user.userId, 'spotify', 'https://baton.example/connected');
      const state = new URL(begun.authorizationUrl).searchParams.get('state')!;
      await assert.rejects(connections.complete('youtube_music', state, 'code'), { code: 'invalid_oauth_state' });
      const connected = await connections.complete('spotify', state, 'code');
      await assert.rejects(connections.complete('spotify', state, 'code'), { code: 'invalid_oauth_state' });
      const row = (await pool.query('SELECT * FROM streaming_connections WHERE id = $1', [connected.connectionId])).rows[0]!;
      assert.equal(row.user_id, user.userId);
      assert.equal(vault.decrypt(row.encrypted_access_token as string, connected.connectionId), 'access-secret');
      assert.equal(vault.decrypt(row.encrypted_refresh_token as string, connected.connectionId), 'refresh-secret');
      assert.ok(!JSON.stringify(await connections.list(user.userId)).includes('secret'));
      assert.equal((await connect(user.userId)).connectionId, connected.connectionId);
      accountId = 'other-account';
      await assert.rejects(connect(user.userId), { code: 'provider_account_change_requires_reconcile' });
      accountId = 'account';
      const pending = await connections.begin(user.userId, 'spotify', 'https://baton.example/connected');
      const expiredState = new URL(pending.authorizationUrl).searchParams.get('state')!;
      await pool.query('UPDATE connection_authorizations SET expires_at = now() - interval \'1 second\' WHERE state_hash = $1', [digest(expiredState)]);
      await assert.rejects(connections.complete('spotify', expiredState, 'code'), { code: 'invalid_oauth_state' });
      const denied = await connections.begin(user.userId, 'spotify', 'https://baton.example/connected');
      const deniedState = new URL(denied.authorizationUrl).searchParams.get('state')!;
      await assert.rejects(connections.complete('spotify', deniedState, undefined), { code: 'provider_authorization_denied' });
      await assert.rejects(connections.complete('spotify', deniedState, 'code'), { code: 'invalid_oauth_state' });
      const concurrent = await connections.begin(user.userId, 'spotify', 'https://baton.example/connected');
      const concurrentState = new URL(concurrent.authorizationUrl).searchParams.get('state')!;
      const before = exchangeCount;
      await Promise.allSettled([connections.complete('spotify', concurrentState, 'code'), connections.complete('spotify', concurrentState, 'code')]);
      assert.equal(exchangeCount, before + 1);
      const apple = await connections.registerApple(user.userId, 'music-secret');
      assert.equal(apple.storefront, 'gb');
      assert.ok(!JSON.stringify(await connections.list(user.userId)).includes('music-secret'));
    });

    await context.test('groups and multi-member invitations are idempotent, authorized, hashed, expiring and revocable', async () => {
      const owner = await login();
      const guest = await login();
      const key = randomUUID();
      const group = await groups.create(owner.userId, 'Group', key);
      assert.deepEqual(await groups.create(owner.userId, 'Group', key), group);
      await assert.rejects(groups.create(owner.userId, 'Different', key), { code: 'idempotency_conflict' });
      await assert.rejects(groups.invite(guest.userId, group.groupId, randomUUID()), { code: 'group_not_found' });
      const inviteKey = randomUUID();
      const invite = await groups.invite(owner.userId, group.groupId, inviteKey);
      assert.deepEqual(await groups.invite(owner.userId, group.groupId, inviteKey), invite);
      assert.deepEqual(await groups.preview(invite.token), { name: 'Group' });
      const accepted = await Promise.all([groups.accept(guest.userId, invite.token), groups.accept(guest.userId, invite.token)]);
      assert.equal(accepted[0]!.membershipId, accepted[1]!.membershipId);
      assert.equal((await pool.query('SELECT count(*) FROM invite_acceptances WHERE invite_id = $1', [invite.inviteId])).rows[0]!.count, '1');
      const stored = JSON.stringify((await pool.query('SELECT * FROM playlist_invites')).rows)
        + JSON.stringify((await pool.query('SELECT * FROM onboarding_requests')).rows);
      assert.ok(!stored.includes(invite.token));
      await groups.revoke(owner.userId, group.groupId, invite.inviteId);
      await assert.rejects(groups.accept(guest.userId, invite.token), { code: 'invite_not_found' });
      const expired = await groups.invite(owner.userId, group.groupId, randomUUID());
      await pool.query('UPDATE playlist_invites SET expires_at = now() - interval \'1 second\' WHERE id = $1', [expired.inviteId]);
      await assert.rejects(groups.preview(expired.token), { code: 'invite_not_found' });
    });

    await context.test('provisioning is once-only, skips history and delivers future events in order', async () => {
      const item = await setup();
      const stranger = await login();
      await assert.rejects(provisioning.start(stranger.userId, item.group.membershipId, item.connection.connectionId, randomUUID()), { code: 'membership_not_found' });
      const strangerConnection = await connect(stranger.userId);
      await assert.rejects(provisioning.start(item.user.userId, item.group.membershipId, strangerConnection.connectionId, randomUUID()), { code: 'active_connection_required' });
      const history = await event(item.group.groupId, item.user.userId);
      const before = creates;
      await Promise.allSettled([provisioning.deliver(item.attemptId), provisioning.deliver(item.attemptId)]);
      await provisioning.deliver(item.attemptId);
      assert.equal(creates, before + 1);
      assert.equal((await attempt(item.attemptId)).status, 'succeeded');
      const status = await provisioning.status(item.user.userId, item.group.membershipId);
      assert.equal(status.status, 'active');
      assert.equal(status.provisionedAtSequence, history.sequence);
      assert.equal(status.lastSyncedSequence, history.sequence);
      assert.equal(status.historicalBackfill, 'deferred_sprint_6');
      await new FanOutPlanner(pool, queue).plan(history.eventId);
      assert.equal((await pool.query('SELECT count(*) FROM sync_delivery_logs WHERE playlist_event_id = $1', [history.eventId])).rows[0]!.count, '0');
      const future = await event(item.group.groupId, item.user.userId);
      await new FanOutPlanner(pool, queue).plan(future.eventId);
      await new FanOutWorker(pool, queue, registry, vault).deliver(item.group.membershipId, future.sequence);
      assert.ok(writes.includes(future.trackId));
      assert.ok(!writes.includes(history.trackId));
      await assert.rejects(provisioning.start(item.user.userId, item.group.membershipId, item.connection.connectionId, randomUUID()), { code: 'membership_already_provisioned' });
      await connections.revoke(item.user.userId, item.connection.connectionId);
      assert.equal((await provisioning.status(item.user.userId, item.group.membershipId)).status, 'paused');
    });

    await context.test('rate limits retry only known rejected writes and stop at the attempt bound', async () => {
      const item = await setup();
      createBehavior = async () => { throw new ProviderSyncError('RATE_LIMITED', 5); };
      for (let count = 1; count <= 5; count += 1) {
        await pool.query('UPDATE provisioning_attempts SET next_attempt_at = NULL WHERE id = $1', [item.attemptId]);
        await provisioning.deliver(item.attemptId);
        assert.equal((await attempt(item.attemptId)).status, count < 5 ? 'failed_retryable' : 'failed_terminal');
      }
      assert.equal((await attempt(item.attemptId)).attempt_count, 5);
      createBehavior = undefined;
    });

    await context.test('a rejected create refreshes once, persists rotated tokens and never loops on unauthorized responses', async () => {
      const item = await setup();
      let calls = 0;
      createBehavior = async () => { calls += 1; if (calls === 1) throw new ProviderSyncError('TOKEN_EXPIRED'); return 'refreshed-playlist'; };
      await provisioning.deliver(item.attemptId);
      assert.equal(calls, 2);
      assert.equal((await attempt(item.attemptId)).status, 'succeeded');
      const row = (await pool.query('SELECT * FROM streaming_connections WHERE id = $1', [item.connection.connectionId])).rows[0]!;
      assert.equal(vault.decrypt(row.encrypted_access_token as string, item.connection.connectionId), 'rotated-access');
      assert.equal(vault.decrypt(row.encrypted_refresh_token as string, item.connection.connectionId), 'rotated-refresh');
      const rejected = await setup();
      calls = 0;
      createBehavior = async () => { calls += 1; throw new ProviderSyncError('TOKEN_EXPIRED'); };
      await provisioning.deliver(rejected.attemptId);
      assert.equal(calls, 2);
      assert.equal((await attempt(rejected.attemptId)).status, 'failed_terminal');
      assert.equal((await connections.list(rejected.user.userId))[0]!.status, 'needs_reauth');
      createBehavior = undefined;
    });

    await context.test('provisioning request idempotency is transactional and revocation prevents a queued create', async () => {
      const user = await login();
      const selected = await connect(user.userId);
      const group = await groups.create(user.userId, 'Atomic', randomUUID());
      const broken = new ProvisioningService(pool, { async sendInTransaction() { throw new Error('queue unavailable'); } }, registry, vault);
      await assert.rejects(broken.start(user.userId, group.membershipId, selected.connectionId, randomUUID()), /queue unavailable/);
      assert.equal((await provisioning.status(user.userId, group.membershipId)).status, 'invited');
      assert.equal((await pool.query('SELECT count(*) FROM provisioning_attempts WHERE membership_id = $1', [group.membershipId])).rows[0]!.count, '0');
      const key = randomUUID();
      const first = await provisioning.start(user.userId, group.membershipId, selected.connectionId, key);
      assert.deepEqual(await provisioning.start(user.userId, group.membershipId, selected.connectionId, key), first);
      const apple = await connections.registerApple(user.userId, 'music-secret');
      await assert.rejects(provisioning.start(user.userId, group.membershipId, apple.connectionId, key), { code: 'idempotency_conflict' });
      const before = creates;
      await connections.revoke(user.userId, selected.connectionId);
      await provisioning.deliver(first.attemptId);
      assert.equal(creates, before);
      assert.equal((await provisioning.status(user.userId, group.membershipId)).status, 'paused');
      assert.equal((await attempt(first.attemptId)).status, 'failed_terminal');
    });

    await context.test('ambiguous writes, malformed create responses and abandoned claims never create twice', async () => {
      for (const mode of ['ambiguous', 'invalid', 'abandoned']) {
        const item = await setup();
        const before = creates;
        if (mode === 'abandoned') await pool.query("UPDATE provisioning_attempts SET status = 'creating' WHERE id = $1", [item.attemptId]);
        createBehavior = async () => { throw new ProviderSyncError(mode === 'invalid' ? 'INVALID_RESPONSE' : 'AMBIGUOUS_WRITE'); };
        await provisioning.deliver(item.attemptId);
        await provisioning.deliver(item.attemptId);
        assert.equal((await attempt(item.attemptId)).status, 'needs_reconcile');
        assert.equal(creates, before + (mode === 'abandoned' ? 0 : 1));
        await assert.rejects(provisioning.start(item.user.userId, item.group.membershipId, item.connection.connectionId, randomUUID()), { code: 'provisioning_requires_reconcile' });
      }
      createBehavior = undefined;
    });

    await context.test('eligibility changes and non-refreshable authentication failures prevent activation', async () => {
      const removed = await setup();
      await pool.query("UPDATE playlist_memberships SET status = 'removed' WHERE id = $1", [removed.group.membershipId]);
      const before = creates;
      await provisioning.deliver(removed.attemptId);
      assert.equal(creates, before);
      assert.equal((await attempt(removed.attemptId)).last_error, 'MEMBERSHIP_CHANGED');
      const revokedDuringCreate = await setup();
      createBehavior = async () => {
        await pool.query("UPDATE playlist_memberships SET status = 'removed' WHERE id = $1", [revokedDuringCreate.group.membershipId]);
        return 'known-orphan-playlist';
      };
      await provisioning.deliver(revokedDuringCreate.attemptId);
      assert.equal((await attempt(revokedDuringCreate.attemptId)).status, 'needs_reconcile');
      assert.equal((await attempt(revokedDuringCreate.attemptId)).external_playlist_id, 'known-orphan-playlist');
      const user = await login();
      const apple = await connections.registerApple(user.userId, 'music-secret');
      const group = await groups.create(user.userId, 'Apple', randomUUID());
      const request = await provisioning.start(user.userId, group.membershipId, apple.connectionId, randomUUID());
      createBehavior = async () => { throw new ProviderSyncError('TOKEN_EXPIRED'); };
      await provisioning.deliver(request.attemptId);
      assert.equal((await attempt(request.attemptId)).status, 'failed_terminal');
      assert.equal((await connections.list(user.userId))[0]!.status, 'needs_reauth');
      createBehavior = undefined;
    });

    await context.test('HTTP endpoints authenticate, bound bodies, hide errors and expose actionable status', async () => {
      api.listen(0, '127.0.0.1');
      await once(api, 'listening');
      const address = api.address();
      assert.ok(address && typeof address !== 'string');
      const base = `http://127.0.0.1:${address.port}`;
      const call = (path: string, data: unknown, token?: string, key?: string) => fetch(`${base}${path}`, {
        method: 'POST', headers: { 'content-type': 'application/json', ...(token ? { authorization: `Bearer ${token}` } : {}),
          ...(key ? { 'idempotency-key': key } : {}) }, body: JSON.stringify(data),
      });
      let response = await call('/api/auth/apple/challenge', {});
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('cache-control'), 'no-store');
      const challenge = await response.json() as { challenge: string };
      response = await call('/api/auth/apple', { code: 'http-user', challenge: challenge.challenge });
      assert.equal(response.status, 200);
      const user = await response.json() as { accessToken: string; userId: string };
      assert.equal((await call('/api/playlists', { name: 'No auth' })).status, 401);
      assert.equal((await call('/api/playlists', { name: 'Group', userId: user.userId }, user.accessToken, randomUUID())).status, 400);
      assert.equal((await call('/api/playlists', { name: 'x'.repeat(17000) }, user.accessToken, randomUUID())).status, 413);
      response = await call('/api/playlists', { name: 'HTTP Group' }, user.accessToken, randomUUID());
      assert.equal(response.status, 201);
      const group = await response.json() as { membershipId: string };
      const selected = await connect(user.userId);
      response = await call(`/api/memberships/${group.membershipId}/provisioning`, { connectionId: selected.connectionId }, user.accessToken, randomUUID());
      assert.equal(response.status, 202);
      const request = await response.json() as { attemptId: string };
      await provisioning.deliver(request.attemptId);
      response = await fetch(`${base}/api/memberships/${group.membershipId}/provisioning`, { headers: { authorization: `Bearer ${user.accessToken}` } });
      assert.equal(response.status, 200);
      assert.equal((await response.json() as { status: string }).status, 'active');
      const bad = await sessions.challenge();
      response = await call('/api/auth/apple', { code: 'invalid', challenge: bad.challenge });
      assert.equal(response.status, 503);
      assert.ok(!(await response.text()).includes('private-provider-error'));
      response = await call('/api/auth/logout', {}, user.accessToken);
      assert.equal(response.status, 200);
      assert.equal((await call('/api/playlists', { name: 'Revoked' }, user.accessToken, randomUUID())).status, 401);
    });

    await context.test('registered pg-boss handler provisions a queued membership', async () => {
      await pool.query("DELETE FROM pgboss.job WHERE name = 'provision-membership'");
      await queue.register('provision-membership', payload => provisioning.deliver(payload.attemptId));
      const item = await setup();
      for (let tries = 0; tries < 80 && (await attempt(item.attemptId)).status !== 'succeeded'; tries += 1) await delay(100);
      assert.equal((await attempt(item.attemptId)).status, 'succeeded');
    });
  } finally {
    if (api.listening) { api.closeAllConnections(); await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve())); }
    if (started) await queue.stop();
    await pool.end();
    if (created) await admin.query(`DROP DATABASE "${databaseName}"`);
    await admin.end();
  }
});
