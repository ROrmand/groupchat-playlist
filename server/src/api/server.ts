import { createServer, type IncomingMessage, type Server } from 'node:http';
import { IngestionError } from '../domain/errors.js';
import type { IngestionResult } from '../services/PlaylistIngestionService.js';
import { IngestionRateLimiter, uuidPattern } from './auth.js';

export interface IngestionApi {
  authenticate(authorization: string | undefined): Promise<string>;
  add(playlistId: string, userId: string, rawInput: string): Promise<IngestionResult>;
}

async function readInput(request: IncomingMessage): Promise<string> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new IngestionError(415, 'json_required');
  if (Number(request.headers['content-length'] ?? 0) > 16384) throw new IngestionError(413, 'body_too_large');
  const chunks: Buffer[] = [];
  let length = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    length += Buffer.byteLength(chunk);
    if (length > 16384) throw new IngestionError(413, 'body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  let body: unknown;
  try { body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
  catch { throw new IngestionError(400, 'invalid_json'); }
  if (!body || typeof body !== 'object' || Array.isArray(body)) throw new IngestionError(400, 'raw_input_required');
  const record = body as Record<string, unknown>;
  if (Object.keys(record).some(key => key !== 'rawInput') || typeof record.rawInput !== 'string' || !record.rawInput.trim()) {
    throw new IngestionError(400, 'raw_input_required');
  }
  if (Buffer.byteLength(record.rawInput) > 8192) throw new IngestionError(413, 'input_too_long');
  return record.rawInput;
}

export function createApi(checkDatabase: () => Promise<void>, ingestion?: IngestionApi): Server {
  const limiter = new IngestionRateLimiter();
  return createServer(async (request, response) => {
    response.setHeader('Content-Type', 'application/json');
    const route = /^\/api\/playlists\/([^/]+)\/items$/.exec(request.url ?? '');
    if (request.method === 'POST' && route) {
      try {
        if (!ingestion) throw new IngestionError(503, 'ingestion_not_configured');
        const userId = await ingestion.authenticate(request.headers.authorization);
        limiter.check(userId);
        const playlistId = route[1]!;
        if (!uuidPattern.test(playlistId)) throw new IngestionError(400, 'invalid_playlist_id');
        const rawInput = await readInput(request);
        const result = await ingestion.add(playlistId, userId, rawInput);
        response.writeHead(result.status).end(JSON.stringify({
          message: result.status === 200 ? 'Already in playlist' : 'Track accepted',
          canonicalTrackId: result.canonicalTrackId, event: result.event,
        }));
      } catch (error) {
        const known = error instanceof IngestionError ? error : new IngestionError(503, 'ingestion_unavailable');
        if (known.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
        if (known.status === 429) response.setHeader('Retry-After', '60');
        if (!request.complete) {
          response.setHeader('Connection', 'close');
          request.resume();
        }
        response.writeHead(known.status).end(JSON.stringify({ error: known.code }));
      }
      return;
    }
    if (request.method !== 'GET' || request.url !== '/healthz') {
      response.writeHead(404).end(JSON.stringify({ error: 'not_found' }));
      return;
    }
    try {
      await checkDatabase();
      response.writeHead(200).end(JSON.stringify({ status: 'ok' }));
    } catch {
      response.writeHead(503).end(JSON.stringify({ status: 'unavailable' }));
    }
  }).setTimeout(10000);
}
