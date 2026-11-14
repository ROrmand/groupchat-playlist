import { ProviderSyncError } from './StreamingProviderAdapter.js';

export type ProviderTransport = (url: string, init: RequestInit) => Promise<Response>;
const hosts = new Set(['api.music.apple.com', 'api.spotify.com', 'accounts.spotify.com', 'www.googleapis.com', 'oauth2.googleapis.com']);

export class ProviderHttp {
  constructor(private readonly transport: ProviderTransport = fetch) {}

  async request(url: string, init: RequestInit, mutation = false, playlist = false): Promise<Record<string, unknown>> {
    const target = new URL(url);
    if (target.protocol !== 'https:' || !hosts.has(target.hostname) || target.username || target.password || target.port) {
      throw new ProviderSyncError('NOT_CONFIGURED');
    }
    try {
      const response = await this.transport(url, { ...init, redirect: 'error', signal: AbortSignal.timeout(10000) });
      if (response.status === 401) throw new ProviderSyncError('TOKEN_EXPIRED');
      if (response.status === 429) {
        const header = response.headers.get('retry-after') ?? '1';
        const seconds = /^\d+$/.test(header) ? Number(header) : Math.ceil((Date.parse(header) - Date.now()) / 1000);
        throw new ProviderSyncError('RATE_LIMITED', Number.isFinite(seconds) ? Math.max(1, seconds) : 1);
      }
      if (response.status === 404) throw new ProviderSyncError(playlist ? 'PLAYLIST_NOT_FOUND' : 'TRACK_UNAVAILABLE');
      if (response.status === 403) throw new ProviderSyncError('FORBIDDEN');
      if (response.status >= 500) throw new ProviderSyncError(mutation ? 'AMBIGUOUS_WRITE' : 'TRANSIENT');
      if (!response.ok) throw new ProviderSyncError('INVALID_RESPONSE');
      if (response.status === 204 || response.headers.get('content-length') === '0') return {};
      if (!response.body) return {};
      const reader = response.body.getReader();
      const chunks: Uint8Array[] = [];
      let bytes = 0;
      for (;;) {
        const next = await reader.read();
        if (next.done) break;
        bytes += next.value.byteLength;
        if (bytes > 1048576) { await reader.cancel(); throw new ProviderSyncError(mutation ? 'AMBIGUOUS_WRITE' : 'INVALID_RESPONSE'); }
        chunks.push(next.value);
      }
      const body = Buffer.concat(chunks).toString('utf8');
      if (!body.trim()) return {};
      const value: unknown = JSON.parse(body);
      return record(value);
    } catch (error) {
      if (error instanceof ProviderSyncError) throw error;
      throw new ProviderSyncError(mutation ? 'AMBIGUOUS_WRITE' : 'TRANSIENT');
    }
  }
}

export function record(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new ProviderSyncError('INVALID_RESPONSE');
  return value as Record<string, unknown>;
}

export function identifier(value: unknown): string {
  if (typeof value !== 'string' || !value) throw new ProviderSyncError('INVALID_RESPONSE');
  return value;
}

export function rows(value: unknown): Record<string, unknown>[] {
  if (!Array.isArray(value)) throw new ProviderSyncError('INVALID_RESPONSE');
  return value.map(record);
}

export function jsonRequest(method: string, token: string, body?: unknown): RequestInit {
  return { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }) };
}
