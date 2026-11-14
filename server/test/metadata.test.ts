import assert from 'node:assert/strict';
import { test } from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';
import { MetadataIngester, isPublicAddress, type MetadataResponse, type MetadataTransport } from '../src/services/MetadataIngester.js';
import { ProviderMetadataClient } from '../src/providers/metadata.js';
import { parseChatText } from '../src/domain/ChatTextParser.js';

const host = 'api.music.apple.com';
const publicAddress = { address: '93.184.216.34', family: 4 };
function response(content = '{}', overrides: Partial<MetadataResponse> = {}): MetadataResponse {
  return { status: 200, body: (async function* () { yield Buffer.from(content); })(), close() {}, ...overrides };
}

test('SSRF classification blocks local, reserved, IPv6 and mapped private addresses', () => {
  for (const address of ['127.0.0.1', '0.0.0.0', '10.1.2.3', '172.16.1.1', '192.168.0.1',
    '169.254.169.254', '100.100.100.200', '224.0.0.1', '192.0.0.1', '::1', '::', 'fc00::1', 'fe80::1',
    '::ffff:127.0.0.1', '::ffff:169.254.169.254', '2001:db8::1', 'not-an-ip']) {
    assert.equal(isPublicAddress(address), false, address);
  }
  assert.equal(isPublicAddress(publicAddress.address), true);
  assert.equal(isPublicAddress('2606:4700:4700::1111'), true);
});

test('metadata validates scheme, host, port, credentials, DNS and pins validated addresses', async () => {
  let requests = 0;
  const http = new MetadataIngester(new Set([host]), async () => [publicAddress], async (_url, address) => {
    requests += 1;
    assert.deepEqual(address, publicAddress);
    return response('{"ok":true}');
  });
  for (const url of [`http://${host}/`, `https://${host}:444/`, `https://user@${host}/`, 'https://evil.test/']) {
    await assert.rejects(http.getJson(new URL(url)), { code: 'unsafe_metadata_url' });
  }
  assert.equal(requests, 0);
  assert.deepEqual(await http.getJson(new URL(`https://${host}/`)), { ok: true });
  for (const addresses of [[], [{ address: '127.0.0.1', family: 4 }], [publicAddress, { address: '::1', family: 6 }]]) {
    const blocked = new MetadataIngester(new Set([host]), async () => addresses, async () => { throw new Error('must not connect'); });
    await assert.rejects(blocked.getJson(new URL(`https://${host}/`)), { code: 'unsafe_metadata_address' });
  }
});

test('redirects re-resolve DNS, reject rebinding, and never forward credentials cross-origin', async () => {
  let resolutions = 0;
  let requests = 0;
  const rebound = new MetadataIngester(new Set([host]), async () => ++resolutions === 1 ? [publicAddress] : [{ address: '10.0.0.1', family: 4 }], async () => {
    requests += 1;
    return response('', { status: 302, location: '/next' });
  });
  await assert.rejects(rebound.getJson(new URL(`https://${host}/`)), { code: 'unsafe_metadata_address' });
  assert.equal(requests, 1);
  const cross = new MetadataIngester(new Set([host, 'api.spotify.com']), async () => [publicAddress], async () => response('', { status: 302, location: 'https://api.spotify.com/' }));
  await assert.rejects(cross.getJson(new URL(`https://${host}/`), { authorization: 'Bearer secret' }), { code: 'cross_origin_metadata_redirect' });
  const loop = new MetadataIngester(new Set([host]), async () => [publicAddress], async () => response('', { status: 302, location: '/again' }));
  await assert.rejects(loop.getJson(new URL(`https://${host}/`)), { code: 'metadata_redirect_limit' });
});

test('metadata enforces streamed bytes, declared length, encoding, JSON and provider statuses', async () => {
  const cases: [MetadataResponse, string][] = [
    [response('x'.repeat(1048577)), 'metadata_too_large'],
    [response('{}', { contentLength: '1048577' }), 'metadata_too_large'],
    [response('{}', { contentLength: 'bad' }), 'metadata_too_large'],
    [response('{}', { contentEncoding: 'gzip' }), 'unsupported_metadata_encoding'],
    [response('not-json'), 'invalid_metadata_json'],
    [response('{}', { status: 404 }), 'track_unavailable'],
    [response('{}', { status: 429 }), 'metadata_rate_limited'],
    [response('{}', { status: 401 }), 'metadata_provider_error'],
  ];
  for (const [stub, code] of cases) {
    let closed = false;
    stub.close = () => { closed = true; };
    const http = new MetadataIngester(new Set([host]), async () => [publicAddress], async () => stub);
    await assert.rejects(http.getJson(new URL(`https://${host}/`)), { code });
    assert.ok(closed);
  }
});

test('one deadline covers DNS, headers, redirects and response body', async () => {
  const slow: MetadataTransport = async () => { await delay(60); return response(); };
  const slowBody = response('{}', { body: (async function* () { await delay(60); yield Buffer.from('{}'); })() });
  const variants = [
    new MetadataIngester(new Set([host]), async () => { await delay(60); return [publicAddress]; }, async () => response(), 15),
    new MetadataIngester(new Set([host]), async () => [publicAddress], slow, 15),
    new MetadataIngester(new Set([host]), async () => [publicAddress], async () => slowBody, 15),
  ];
  for (const http of variants) await assert.rejects(http.getJson(new URL(`https://${host}/`)), { code: 'metadata_timeout' });
  assert.throws(() => new MetadataIngester(new Set([host]), undefined, undefined, 3001), /3000/);
});

test('provider metadata readers use validated IDs and offline API fixtures', async () => {
  let fixture: unknown;
  const requests: URL[] = [];
  const client = new ProviderMetadataClient({ async getJson(url) { requests.push(url); return fixture; } }, {
    appleDeveloperToken: 'test-apple', spotifyAccessToken: 'test-spotify', youtubeApiKey: 'test-youtube',
  });
  const apple = parseChatText('https://music.apple.com/us/song/456')[0]!;
  fixture = { data: [{ id: '456', attributes: { name: 'Song', artistName: 'Artist', albumName: 'Album', durationInMillis: 180000, isrc: 'USAAA2300001' } }] };
  assert.equal((await client.resolve(apple)).isrc, 'USAAA2300001');
  const spotify = parseChatText('spotify:track:4cOdK2wGLETKBW3PvgPWqT')[0]!;
  fixture = { id: spotify.externalTrackId, name: 'Song', artists: [{ name: 'Artist' }], album: { name: 'Album' }, duration_ms: 180000, external_ids: { isrc: 'USAAA2300001' } };
  assert.equal((await client.resolve(spotify)).durationMs, 180000);
  const youtube = parseChatText('https://youtu.be/dQw4w9WgXcQ')[0]!;
  fixture = { items: [{ id: youtube.externalTrackId, snippet: { title: 'Song', channelTitle: 'Artist - Topic', categoryId: '10', liveBroadcastContent: 'none' }, contentDetails: { duration: 'PT3M1S' } }] };
  assert.deepEqual(await client.resolve(youtube), { title: 'Song', artist: 'Artist', album: null, durationMs: 181000, isrc: null });
  fixture = { items: [{ id: youtube.externalTrackId, snippet: { title: 'Unverified', channelTitle: 'Random uploader' } }] };
  await assert.rejects(client.resolve(youtube), { code: 'unverified_youtube_recording' });
  assert.deepEqual(requests.map(url => url.hostname), ['api.music.apple.com', 'api.spotify.com', 'www.googleapis.com', 'www.googleapis.com']);
  const unconfigured = new ProviderMetadataClient({ async getJson() { throw new Error('must not request'); } }, {});
  for (const link of [apple, spotify, youtube]) await assert.rejects(unconfigured.resolve(link), { status: 503 });
  fixture = { data: [{ id: 'wrong', attributes: {} }] };
  await assert.rejects(client.resolve(apple), { code: 'metadata_id_mismatch' });
});
