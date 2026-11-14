import assert from 'node:assert/strict';
import { generateKeyPairSync } from 'node:crypto';
import { test } from 'node:test';
import { jwtVerify, importSPKI } from 'jose';
import { AppleMusicAdapter, appleDeveloperToken } from '../src/providers/AppleMusicAdapter.js';
import { SpotifyAdapter } from '../src/providers/SpotifyAdapter.js';
import { YouTubeMusicAdapter } from '../src/providers/YouTubeMusicAdapter.js';
import { ProviderHttp } from '../src/providers/http.js';
import { ProviderRegistry, ProviderSyncError, type StreamingProviderAdapter } from '../src/providers/StreamingProviderAdapter.js';
import { configureProviders } from '../src/providers/configure.js';
import { TokenVault } from '../src/services/TokenVault.js';

const connection = { id: 'connection', accessToken: 'secret-access', refreshToken: 'secret-refresh', storefront: 'us' };
const track = { id: 'canonical', isrc: 'USAAA2300001', normalizedTitle: 'song', normalizedArtist: 'artist', durationMs: 180000 };
const oauth = { clientId: 'client', clientSecret: 'secret' };
const adapters = (http: ProviderHttp): StreamingProviderAdapter[] => [new AppleMusicAdapter(http, async () => 'developer'),
  new SpotifyAdapter(http, oauth), new YouTubeMusicAdapter(http, oauth)];
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status });

test('all adapters standardize authentication, rate limits, missing playlists and ambiguous writes', async () => {
  for (const [status, code] of [[401, 'TOKEN_EXPIRED'], [403, 'FORBIDDEN'], [404, 'PLAYLIST_NOT_FOUND'],
    [429, 'RATE_LIMITED'], [503, 'AMBIGUOUS_WRITE']] as const) {
    const http = new ProviderHttp(async () => new Response('', { status, headers: { 'retry-after': '120' } }));
    for (const adapter of adapters(http)) {
      await assert.rejects(adapter.appendTracks(connection, 'playlist', ['track']), error => {
        assert.ok(error instanceof ProviderSyncError);
        assert.equal(error.code, code);
        assert.equal(error.message.includes(connection.accessToken), false);
        if (status === 429) assert.equal(error.retryAfterSeconds, 120);
        return true;
      });
    }
  }
  for (const adapter of adapters(new ProviderHttp(async () => { throw new Error('secret-access'); }))) {
    await assert.rejects(adapter.appendTracks(connection, 'playlist', ['track']), { code: 'AMBIGUOUS_WRITE' });
    await assert.rejects(adapter.appendTracks(connection, 'playlist', []), { code: 'INVALID_RESPONSE' });
  }
  for (const adapter of adapters(new ProviderHttp(async () => new Response('', { status: 503 })))) {
    await assert.rejects(adapter.resolveTrackId(connection, track, 'us'), { code: 'TRANSIENT' });
  }
});

test('Spotify uses current playlist endpoints, conservative matching, batch URIs and OAuth rotation', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const http = new ProviderHttp(async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/search')) return json({ tracks: { items: [{ id: 'spotify-song', external_ids: { isrc: track.isrc }, is_playable: true }] } });
    if (url.includes('/api/token')) return json({ access_token: 'renewed', refresh_token: 'rotated', expires_in: 3600 });
    if (url.endsWith('/me/playlists')) return json({ id: 'new-playlist' });
    return json({ snapshot_id: 'snapshot' });
  });
  const adapter = new SpotifyAdapter(http, oauth);
  assert.equal(await adapter.createPlaylist(connection, 'Name'), 'new-playlist');
  assert.equal(await adapter.resolveTrackId(connection, track, 'us'), 'spotify-song');
  assert.deepEqual(await adapter.appendTracks(connection, 'playlist', ['one', 'two']), [
    { trackId: 'one', handle: 'spotify:track:one' }, { trackId: 'two', handle: 'spotify:track:two' },
  ]);
  await adapter.removeTracks(connection, 'playlist', [{ trackId: 'one', handle: 'spotify:track:one' }]);
  assert.deepEqual(JSON.parse(String(requests[3]!.init.body)), { items: [{ uri: 'spotify:track:one' }] });
  assert.ok(requests[2]!.url.endsWith('/playlists/playlist/items'));
  assert.deepEqual(await adapter.refreshToken(connection), { accessToken: 'renewed', refreshToken: 'rotated', expiresIn: 3600 });
  assert.equal(new URLSearchParams(String(requests[4]!.init.body)).get('refresh_token'), connection.refreshToken);
  const fallback = new SpotifyAdapter(new ProviderHttp(async () => json({ tracks: { items: [{ id: 'fallback', name: 'Song',
    artists: [{ name: 'Artist' }], duration_ms: 183000 }] } })));
  assert.equal(await fallback.resolveTrackId(connection, { ...track, isrc: null }, 'us'), 'fallback');
  assert.equal(await fallback.resolveTrackId(connection, track, 'us'), null);
});

test('YouTube captures playlist item handles, validates Topic recordings and deletes by item ID', async () => {
  const requests: { url: string; init: RequestInit }[] = [];
  const adapter = new YouTubeMusicAdapter(new ProviderHttp(async (url, init) => {
    requests.push({ url, init });
    if (url.includes('/search?')) return json({ items: [{ id: { videoId: 'video' } }] });
    if (url.includes('/videos?')) return json({ items: [{ id: 'video', snippet: { title: 'Song', channelTitle: 'Artist - Topic',
      categoryId: '10', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT3M' }, status: { embeddable: true } }] });
    if (init.method === 'DELETE') return new Response(null, { status: 204 });
    if (url.includes('oauth2')) return json({ access_token: 'google-new', expires_in: 1800 });
    return json({ id: 'item-handle' });
  }), oauth);
  assert.equal(adapter.capabilities.supportsISRC, false);
  assert.equal(await adapter.resolveTrackId(connection, track, 'us'), 'video');
  assert.deepEqual(await adapter.appendTracks(connection, 'playlist', ['video']), [{ trackId: 'video', handle: 'item-handle' }]);
  await adapter.removeTracks(connection, 'playlist', [{ trackId: 'video', handle: 'item-handle' }]);
  assert.equal(new URL(requests[3]!.url).searchParams.get('id'), 'item-handle');
  assert.equal((await adapter.refreshToken(connection)).refreshToken, connection.refreshToken);
  const malformed = new YouTubeMusicAdapter(new ProviderHttp(async () => json({})));
  await assert.rejects(malformed.appendTracks(connection, 'playlist', ['video']), { code: 'AMBIGUOUS_WRITE' });
});

test('Apple signs developer JWTs, attaches user tokens, resolves catalog IDs and has no server delete', async () => {
  const keys = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  const signer = appleDeveloperToken({ teamId: 'TEAM', keyId: 'KEY', privateKey: keys.privateKey.export({ type: 'pkcs8', format: 'pem' }).toString() });
  const token = await signer();
  assert.equal(await signer(), token);
  const verified = await jwtVerify(token, await importSPKI(keys.publicKey.export({ type: 'spki', format: 'pem' }).toString(), 'ES256'), { issuer: 'TEAM' });
  assert.equal(verified.protectedHeader.kid, 'KEY');
  const requests: RequestInit[] = [];
  const adapter = new AppleMusicAdapter(new ProviderHttp(async (_url, init) => {
    requests.push(init);
    return init.method === 'GET' ? json({ data: [{ id: 'apple-song', attributes: { isrc: track.isrc } }] }) : new Response(null, { status: 204 });
  }), signer);
  assert.equal(await adapter.resolveTrackId(connection, track, 'us'), 'apple-song');
  await adapter.appendTracks(connection, 'playlist', ['apple-song']);
  assert.equal((requests[1]!.headers as Record<string, string>)['music-user-token'], connection.accessToken);
  assert.equal(adapter.capabilities.supportsServerSideDelete, false);
  assert.equal(adapter.capabilities.tokenRefreshMode, 'on_device_sdk');
});

test('vault encrypts with random authenticated nonces and binds ciphertext to its connection', () => {
  const key = Buffer.alloc(32, 7).toString('base64');
  const vault = new TokenVault(key);
  const encrypted = vault.encrypt('sensitive-token', 'connection');
  assert.equal(vault.decrypt(encrypted, 'connection'), 'sensitive-token');
  assert.notEqual(vault.encrypt('sensitive-token', 'connection'), encrypted);
  assert.equal(encrypted.includes('sensitive-token'), false);
  assert.throws(() => vault.decrypt(encrypted, 'other-connection'));
  assert.throws(() => new TokenVault('weak'));
  assert.throws(() => vault.decrypt('plaintext-token', 'connection'));
  assert.equal(configureProviders({}), undefined);
  assert.throws(() => configureProviders({ TOKEN_ENCRYPTION_KEY: key, SPOTIFY_CLIENT_ID: 'partial' }), /both/);
  const registry = new ProviderRegistry();
  const adapter = new SpotifyAdapter(new ProviderHttp());
  registry.register(adapter);
  assert.equal(registry.get('spotify'), adapter);
  assert.throws(() => registry.register(adapter), /already/);
  assert.throws(() => registry.get('unknown'), { code: 'NOT_CONFIGURED' });
});

test('provider HTTP refuses unsafe destinations, redirects, oversized bodies and invalid JSON', async () => {
  let calls = 0;
  const http = new ProviderHttp(async () => { calls += 1; return json({}); });
  await assert.rejects(http.request('http://api.spotify.com/v1/me', {}), { code: 'NOT_CONFIGURED' });
  await assert.rejects(http.request('https://example.invalid/', {}), { code: 'NOT_CONFIGURED' });
  assert.equal(calls, 0);
  const large = new ProviderHttp(async () => new Response('x'.repeat(1048577)));
  await assert.rejects(large.request('https://api.spotify.com/v1/me', {}), { code: 'INVALID_RESPONSE' });
  const broken = new ProviderHttp(async (_url, init) => {
    assert.equal(init.redirect, 'error');
    assert.ok(init.signal);
    return new Response('not-json');
  });
  await assert.rejects(broken.request('https://api.spotify.com/v1/me', {}, true), { code: 'AMBIGUOUS_WRITE' });
});
