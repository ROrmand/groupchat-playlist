import assert from 'node:assert/strict';
import { once } from 'node:events';
import { request as httpRequest } from 'node:http';
import { test } from 'node:test';
import { createApi } from '../src/api/server.js';
import { IngestionError } from '../src/domain/errors.js';

test('ingestion HTTP boundary validates bodies, refuses forged identities, limits requests and hides errors', async () => {
  const userId = '00000000-0000-0000-0000-000000000001';
  let failure: Error | null = null;
  let calls = 0;
  const api = createApi(async () => {}, {
    async authenticate(authorization) {
      if (authorization !== 'Bearer good') throw new IngestionError(401, 'invalid_session');
      return userId;
    },
    async add(_playlistId, actorId) {
      assert.equal(actorId, userId);
      calls += 1;
      if (failure) throw failure;
      return { status: 200, canonicalTrackId: userId, event: null };
    },
  });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  try {
    const address = api.address();
    assert.ok(address && typeof address !== 'string');
    const base = `http://127.0.0.1:${address.port}`;
    const endpoint = `${base}/api/playlists/${userId}/items`;
    const headers = { authorization: 'Bearer good', 'content-type': 'application/json' };
    const post = (body: string, extraHeaders = headers) => fetch(endpoint, { method: 'POST', headers: extraHeaders, body });
    assert.equal((await post('{"rawInput":"track"}', { 'content-type': 'application/json', authorization: '' })).status, 401);
    assert.equal((await post('{')).status, 400);
    assert.equal((await post('null')).status, 400);
    assert.equal((await post('[]')).status, 400);
    assert.equal((await post('{"rawInput":123}')).status, 400);
    assert.equal((await post('{"rawInput":" "}')).status, 400);
    assert.equal((await post('{"rawInput":"track","sender_id":"forged"}')).status, 400);
    assert.equal((await post('{}', { ...headers, 'content-type': 'text/plain' })).status, 415);
    assert.equal((await post(JSON.stringify({ rawInput: '🔥'.repeat(2049) }))).status, 413);
    assert.equal((await post(JSON.stringify({ rawInput: 'x'.repeat(20000) }))).status, 413);
    const streamedStatus = await new Promise<number>((resolve, reject) => {
      const outgoing = httpRequest(endpoint, { method: 'POST', headers }, response => {
        response.resume();
        response.once('end', () => resolve(response.statusCode!));
      });
      outgoing.once('error', reject);
      outgoing.write('x'.repeat(9000));
      outgoing.end('x'.repeat(9000));
    });
    assert.equal(streamedStatus, 413);
    assert.equal((await fetch(`${base}/api/playlists/not-a-uuid/items`, { method: 'POST', headers, body: '{}' })).status, 400);
    assert.equal(calls, 0);
    failure = new Error('secret database URL must not leak');
    const failed = await post('{"rawInput":"track"}');
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { error: 'ingestion_unavailable' });
    failure = new IngestionError(403, 'active_membership_required');
    assert.equal((await post('{"rawInput":"track"}')).status, 403);
    failure = null;
    assert.equal((await post('{"rawInput":"track"}')).status, 200);
    let limited = false;
    for (let attempt = 0; attempt < 61; attempt += 1) {
      const result = await post('{"rawInput":"track"}');
      if (result.status === 429) {
        assert.equal(result.headers.get('retry-after'), '60');
        limited = true;
        break;
      }
    }
    assert.ok(limited);
  } finally { await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve())); }
});
