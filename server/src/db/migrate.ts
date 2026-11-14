import { createHash } from 'node:crypto';
import { readdir, readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { Pool } from 'pg';
import { loadConfig } from '../config.js';
import { createPool } from './pool.js';

export async function migrate(pool: Pool, directory = resolve('migrations')): Promise<void> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query('SELECT pg_advisory_xact_lock(731401)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name TEXT PRIMARY KEY, checksum TEXT NOT NULL, applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
    )`);
    const files = (await readdir(directory)).filter(name => /^\d+_[a-z0-9_]+\.sql$/.test(name)).sort();
    const applied = await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations');
    for (const row of applied.rows) {
      if (!files.includes(row.name)) throw new Error(`Applied migration is missing: ${row.name}`);
    }
    for (const name of files) {
      const sql = await readFile(resolve(directory, name), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const previous = applied.rows.find(row => row.name === name);
      if (previous) {
        if (previous.checksum !== checksum) throw new Error(`Applied migration was modified: ${name}`);
        continue;
      }
      if (applied.rows.some(row => row.name > name)) throw new Error(`Migration is out of order: ${name}`);
      await client.query(sql);
      await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [name, checksum]);
    }
    await client.query('COMMIT');
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally {
    client.release();
  }
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const pool = createPool(loadConfig().databaseUrl);
  try { await migrate(pool); } finally { await pool.end(); }
}
