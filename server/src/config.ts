import type { SessionConfig } from './api/auth.js';
import type { MetadataCredentials } from './providers/metadata.js';

export interface Config {
  databaseUrl: string;
  port: number;
  host: string;
  workerConcurrency: number;
  session: SessionConfig | undefined;
  metadataCredentials: MetadataCredentials;
}

function positiveInteger(value: string, name: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 1) throw new Error(`${name} must be a positive integer`);
  return parsed;
}

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  if (env.NODE_ENV === 'production' && env.ALLOW_DEV_SESSIONS === '1') throw new Error('Development sessions cannot be enabled in production');
  if (!env.DATABASE_URL) throw new Error('DATABASE_URL is required');
  const databaseUrl = new URL(env.DATABASE_URL);
  if (!['postgres:', 'postgresql:'].includes(databaseUrl.protocol)) throw new Error('DATABASE_URL must use PostgreSQL');
  const port = positiveInteger(env.PORT ?? '3000', 'PORT');
  if (port > 65535) throw new Error('PORT must be at most 65535');
  if (env.SESSION_JWT_SECRET && Buffer.byteLength(env.SESSION_JWT_SECRET) < 32) throw new Error('SESSION_JWT_SECRET must contain at least 32 bytes');
  return {
    databaseUrl: env.DATABASE_URL,
    port,
    host: env.HOST ?? '127.0.0.1',
    workerConcurrency: positiveInteger(env.WORKER_CONCURRENCY ?? '2', 'WORKER_CONCURRENCY'),
    session: env.SESSION_JWT_SECRET ? {
      secret: env.SESSION_JWT_SECRET, issuer: env.SESSION_JWT_ISSUER ?? 'baton', audience: env.SESSION_JWT_AUDIENCE ?? 'baton-api',
    } : undefined,
    metadataCredentials: {
      ...(env.APPLE_MUSIC_DEVELOPER_TOKEN ? { appleDeveloperToken: env.APPLE_MUSIC_DEVELOPER_TOKEN } : {}),
      ...(env.SPOTIFY_ACCESS_TOKEN ? { spotifyAccessToken: env.SPOTIFY_ACCESS_TOKEN } : {}),
      ...(env.YOUTUBE_API_KEY ? { youtubeApiKey: env.YOUTUBE_API_KEY } : {}),
    },
  };
}
