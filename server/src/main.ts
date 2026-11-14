import { once } from 'node:events';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { JobQueue } from './jobs/queue.js';
import { createApi } from './api/server.js';
import { createSessionVerifier } from './api/auth.js';
import { MetadataIngester } from './services/MetadataIngester.js';
import { ProviderMetadataClient } from './providers/metadata.js';
import { PlaylistIngestionService } from './services/PlaylistIngestionService.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const queue = new JobQueue(config.databaseUrl, config.workerConcurrency, error => {
  console.error('Queue error:', error.message);
});
const metadata = new ProviderMetadataClient(new MetadataIngester(new Set([
  'api.music.apple.com', 'api.spotify.com', 'www.googleapis.com',
])), config.metadataCredentials);
const ingestion = new PlaylistIngestionService(pool, metadata, queue);
const api = createApi(async () => { await pool.query('SELECT 1'); }, {
  authenticate: createSessionVerifier(config.session), add: (playlistId, userId, rawInput) => ingestion.add(playlistId, userId, rawInput),
});
let stopping = false;

async function stop(): Promise<void> {
  if (stopping) return;
  stopping = true;
  try {
    if (api.listening) await new Promise<void>((resolve, reject) => api.close(error => error ? reject(error) : resolve()));
  } finally {
    try { await queue.stop(); } finally { await pool.end(); }
  }
}

try {
  await pool.query('SELECT 1');
  await queue.start();
  api.listen(config.port, config.host);
  await once(api, 'listening');
  console.log(`Baton listening on ${config.host}:${config.port}`);
  for (const signal of ['SIGINT', 'SIGTERM'] as const) {
    process.once(signal, () => { void stop().catch(() => { process.exitCode = 1; }); });
  }
} catch (error) {
  await stop();
  throw error;
}
