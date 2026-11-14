import type { IncomingMessage, ServerResponse } from 'node:http';
import { IngestionError } from '../domain/errors.js';
import type { SessionService } from '../services/SessionService.js';
import type { ConnectionService } from '../services/ConnectionService.js';
import type { GroupService } from '../services/GroupService.js';
import type { ProvisioningService } from '../services/ProvisioningService.js';
import { IngestionRateLimiter, uuidPattern } from './auth.js';

export interface OnboardingServices {
  sessions: SessionService;
  connections: ConnectionService;
  groups: GroupService;
  provisioning: ProvisioningService;
}

async function body(request: IncomingMessage, allowed: readonly string[]): Promise<Record<string, unknown>> {
  if (request.headers['content-type']?.split(';')[0]?.trim().toLowerCase() !== 'application/json') throw new IngestionError(415, 'json_required');
  if (Number(request.headers['content-length'] ?? 0) > 16384) throw new IngestionError(413, 'body_too_large');
  const chunks: Buffer[] = [];
  let bytes = 0;
  for await (const chunk of request.iterator({ destroyOnReturn: false })) {
    bytes += Buffer.byteLength(chunk);
    if (bytes > 16384) throw new IngestionError(413, 'body_too_large');
    chunks.push(Buffer.from(chunk));
  }
  let value: unknown;
  try { value = JSON.parse(Buffer.concat(chunks).toString('utf8')); }
  catch { throw new IngestionError(400, 'invalid_json'); }
  if (!value || typeof value !== 'object' || Array.isArray(value) || Object.keys(value).some(key => !allowed.includes(key))) throw new IngestionError(400, 'invalid_body');
  return value as Record<string, unknown>;
}

function string(value: unknown, max = 4096): string {
  if (typeof value !== 'string' || !value.trim() || Buffer.byteLength(value) > max) throw new IngestionError(400, 'invalid_input');
  return value;
}

function uuid(value: unknown): string {
  const result = string(value, 36);
  if (!uuidPattern.test(result)) throw new IngestionError(400, 'invalid_id');
  return result;
}

export function onboardingRouter(services: OnboardingServices | undefined) {
  const publicLimiter = new IngestionRateLimiter(30);
  const userLimiter = new IngestionRateLimiter();
  return async (request: IncomingMessage, response: ServerResponse): Promise<boolean> => {
    let url: URL;
    try { url = new URL(request.url ?? '/', 'http://localhost'); }
    catch { response.writeHead(400).end(JSON.stringify({ error: 'invalid_url' })); return true; }
    const path = url.pathname;
    const method = request.method;
    const callback = /^\/api\/connections\/(spotify|youtube_music)\/callback$/.exec(path);
    const authorization = /^\/api\/connections\/(spotify|youtube_music)\/authorize$/.exec(path);
    const connection = /^\/api\/connections\/([^/]+)$/.exec(path);
    const invite = /^\/api\/playlists\/([^/]+)\/invites(?:\/([^/]+))?$/.exec(path);
    const membership = /^\/api\/memberships\/([^/]+)\/provisioning$/.exec(path);
    const supported = (method === 'POST' && ['/api/auth/apple/challenge', '/api/auth/apple', '/api/auth/refresh',
      '/api/auth/logout', '/api/auth/revoke-all', '/api/connections/apple_music', '/api/playlists', '/api/invites/preview', '/api/invites/accept'].includes(path))
      || (method === 'GET' && (Boolean(callback) || path === '/api/connections' || Boolean(membership)))
      || (method === 'POST' && (Boolean(authorization) || Boolean(invite && !invite[2]) || Boolean(membership)))
      || (method === 'DELETE' && (Boolean(connection) || Boolean(invite?.[2])));
    if (!supported) return false;
    response.setHeader('Cache-Control', 'no-store');
    response.setHeader('Referrer-Policy', 'no-referrer');
    try {
      if (!services) throw new IngestionError(503, 'onboarding_not_configured');
      publicLimiter.check(request.socket.remoteAddress ?? 'unknown');
      let result: unknown;
      let status = 200;
      if (method === 'POST' && path === '/api/auth/apple/challenge') {
        await body(request, []);
        result = await services.sessions.challenge();
      } else if (method === 'POST' && path === '/api/auth/apple') {
        const input = await body(request, ['code', 'challenge']);
        result = await services.sessions.signIn(string(input.code), string(input.challenge, 128));
      } else if (method === 'POST' && path === '/api/auth/refresh') {
        const input = await body(request, ['refreshToken']);
        result = await services.sessions.refresh(string(input.refreshToken, 128));
      } else if (method === 'GET' && callback) {
        if ([...url.searchParams.keys()].some(key => !['state', 'code', 'error', 'error_description', 'scope', 'authuser', 'prompt'].includes(key))
          || ['state', 'code', 'error'].some(key => url.searchParams.getAll(key).length > 1)) throw new IngestionError(400, 'invalid_callback');
        result = await services.connections.complete(callback[1] as 'spotify' | 'youtube_music', string(url.searchParams.get('state'), 128),
          url.searchParams.has('error') ? undefined : string(url.searchParams.get('code')));
      } else if (method === 'POST' && path === '/api/invites/preview') {
        const input = await body(request, ['token']);
        result = await services.groups.preview(string(input.token, 128));
      } else {
        const userId = await services.sessions.authenticate(request.headers.authorization);
        userLimiter.check(userId);
        const key = request.headers['idempotency-key'];
        const idempotencyKey = () => string(key, 128);
        if (method === 'POST' && ['/api/auth/logout', '/api/auth/revoke-all'].includes(path)) {
          await body(request, []);
          result = await services.sessions.logout(request.headers.authorization, path.endsWith('revoke-all'));
        } else if (method === 'GET' && path === '/api/connections') result = await services.connections.list(userId);
        else if (method === 'POST' && authorization) {
          const input = await body(request, ['returnTo']);
          result = await services.connections.begin(userId, authorization[1] as 'spotify' | 'youtube_music', string(input.returnTo, 2048));
        } else if (method === 'POST' && path === '/api/connections/apple_music') {
          const input = await body(request, ['musicUserToken']);
          result = await services.connections.registerApple(userId, string(input.musicUserToken, 8192));
        } else if (method === 'DELETE' && connection) result = await services.connections.revoke(userId, uuid(connection[1]));
        else if (method === 'POST' && path === '/api/playlists') {
          const input = await body(request, ['name']);
          result = await services.groups.create(userId, string(input.name, 200).trim(), idempotencyKey());
          status = 201;
        } else if (invite) {
          result = method === 'DELETE' ? await services.groups.revoke(userId, uuid(invite[1]), uuid(invite[2]))
            : await (async () => { await body(request, []); return services.groups.invite(userId, uuid(invite[1]), idempotencyKey()); })();
        } else if (method === 'POST' && path === '/api/invites/accept') {
          const input = await body(request, ['token']);
          result = await services.groups.accept(userId, string(input.token, 128));
        } else if (membership) {
          if (method === 'GET') result = await services.provisioning.status(userId, uuid(membership[1]));
          else {
            const input = await body(request, ['connectionId']);
            result = await services.provisioning.start(userId, uuid(membership[1]), uuid(input.connectionId), idempotencyKey());
            status = 202;
          }
        }
      }
      response.writeHead(status).end(JSON.stringify(result));
    } catch (error) {
      const known = error instanceof IngestionError ? error : new IngestionError(503, 'onboarding_unavailable');
      if (known.status === 401) response.setHeader('WWW-Authenticate', 'Bearer');
      if (known.status === 429) response.setHeader('Retry-After', '60');
      if (!request.complete) { response.setHeader('Connection', 'close'); request.resume(); }
      response.writeHead(known.status).end(JSON.stringify({ error: known.code }));
    }
    return true;
  };
}
