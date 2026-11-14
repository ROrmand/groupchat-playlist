import assert from 'node:assert/strict';
import { once } from 'node:events';
import { test } from 'node:test';
import { createApi } from '../src/api/server.js';
import { loadConfig } from '../src/config.js';
import { MockMusicCatalogProvider, trackFixture } from './fixtures.js';
import type { MusicCatalogProvider } from '../src/providers/catalog.js';

test('configuration requires PostgreSQL and validates bounds', () => {
  assert.throws(() => loadConfig({}), /DATABASE_URL/);
  assert.throws(() => loadConfig({ DATABASE_URL: 'https://example.invalid' }), /PostgreSQL/);
  for (const PORT of ['0', '1.5', 'abc', '65536']) {
    assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://localhost/baton', PORT }), /PORT/);
  }
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://localhost/baton', WORKER_CONCURRENCY: '-1' }), /WORKER_CONCURRENCY/);
  assert.equal(loadConfig({ DATABASE_URL: 'postgres://localhost/baton' }).workerConcurrency, 2);
});

test('catalog fixtures are offline and deterministic', async () => {
  const catalog: MusicCatalogProvider = new MockMusicCatalogProvider();
  assert.deepEqual(await catalog.searchTracks('Test Song', 'Test Artist', 'us'), [trackFixture]);
  assert.deepEqual(await catalog.searchTracks('Missing', 'Unknown', 'us'), []);
  assert.equal(await catalog.isrc('track-1', 'us'), trackFixture.isrc);
});

test('health endpoint exposes availability without leaking failures', async () => {
  let available = true;
  const api = createApi(async () => { if (!available) throw new Error('secret connection string'); });
  api.listen(0, '127.0.0.1');
  await once(api, 'listening');
  try {
    const address = api.address();
    assert.ok(address && typeof address !== 'string');
    const url = `http://127.0.0.1:${address.port}`;
    assert.equal((await fetch(`${url}/healthz`)).status, 200);
    available = false;
    const failed = await fetch(`${url}/healthz`);
    assert.equal(failed.status, 503);
    assert.deepEqual(await failed.json(), { status: 'unavailable' });
    assert.equal((await fetch(`${url}/missing`)).status, 404);
    assert.equal((await fetch(`${url}/healthz`, { method: 'POST' })).status, 404);
  } finally {
    await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  }
});
