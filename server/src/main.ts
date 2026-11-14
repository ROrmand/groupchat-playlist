import { once } from 'node:events';
import { loadConfig } from './config.js';
import { createPool } from './db/pool.js';
import { JobQueue } from './jobs/queue.js';
import { createApi } from './api/server.js';

const config = loadConfig();
const pool = createPool(config.databaseUrl);
const queue = new JobQueue(config.databaseUrl, config.workerConcurrency, error => {
  console.error('Queue error:', error.message);
});
const api = createApi(async () => { await pool.query('SELECT 1'); });
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
