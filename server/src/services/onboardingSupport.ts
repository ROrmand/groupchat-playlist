import { createHash, randomBytes } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IngestionError } from '../domain/errors.js';

export const secret = () => randomBytes(32).toString('base64url');
export const digest = (value: string) => createHash('sha256').update(value).digest('hex');

export async function transaction<Result>(pool: Pool, action: (client: PoolClient) => Promise<Result>): Promise<Result> {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const result = await action(client);
    await client.query('COMMIT');
    return result;
  } catch (error) {
    await client.query('ROLLBACK');
    throw error;
  } finally { client.release(); }
}

export async function idempotent<Result>(client: PoolClient, userId: string, operation: string, key: string,
  input: unknown, action: () => Promise<Result>): Promise<Result> {
  if (!/^[A-Za-z0-9_-]{8,128}$/.test(key)) throw new IngestionError(400, 'idempotency_key_required');
  const fingerprint = digest(JSON.stringify(input));
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`request:${userId}:${operation}:${key}`]);
  const existing = (await client.query(`SELECT fingerprint, result FROM onboarding_requests
    WHERE user_id = $1 AND operation = $2 AND idempotency_key = $3`, [userId, operation, key])).rows[0];
  if (existing) {
    if (existing.fingerprint !== fingerprint) throw new IngestionError(409, 'idempotency_conflict');
    return existing.result as Result;
  }
  const result = await action();
  await client.query(`INSERT INTO onboarding_requests VALUES ($1, $2, $3, $4, $5::jsonb)`,
    [userId, operation, key, fingerprint, JSON.stringify(result)]);
  return result;
}
