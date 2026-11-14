export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  workerConcurrency: number;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const databaseUrl = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const port = positiveInteger(env.PORT ?? '3000', 'PORT');
  if (port > 65535) throw new Error('PORT must be at most 65535');
  return {
    databaseUrl: env.DATABASE_URL,
    port,
    host: env.HOST ?? '127.0.0.1',
    workerConcurrency: positiveInteger(env.WORKER_CONCURRENCY ?? '2', 'WORKER_CONCURRENCY'),
  };
}
