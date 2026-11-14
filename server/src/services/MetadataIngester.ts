import { lookup } from 'node:dns/promises';
import { request } from 'node:https';
import ipaddr from 'ipaddr.js';
import { IngestionError } from '../domain/errors.js';

export interface ResolvedAddress { address: string; family: number }
export interface MetadataResponse {
  status: number;
  location?: string;
  contentLength?: string;
  contentEncoding?: string;
  body: AsyncIterable<Uint8Array>;
  close(): void;
}
export type MetadataResolver = (hostname: string) => Promise<ResolvedAddress[]>;
export type MetadataTransport = (url: URL, address: ResolvedAddress, headers: Readonly<Record<string, string>>, signal: AbortSignal) => Promise<MetadataResponse>;

export function isPublicAddress(address: string): boolean {
  try { return ipaddr.process(address).range() === 'unicast'; } catch { return false; }
}

function abortable<Value>(operation: Promise<Value>, signal: AbortSignal): Promise<Value> {
  return new Promise((resolve, reject) => {
    const abort = () => reject(new IngestionError(504, 'metadata_timeout'));
    if (signal.aborted) { abort(); return; }
    signal.addEventListener('abort', abort, { once: true });
    operation.then(resolve, reject).finally(() => signal.removeEventListener('abort', abort));
  });
}

export const httpsMetadataTransport: MetadataTransport = (url, address, headers, signal) => new Promise((resolve, reject) => {
  const outgoing = request({
    protocol: 'https:', hostname: address.address, family: address.family, port: 443,
    servername: url.hostname, path: `${url.pathname}${url.search}`, method: 'GET', signal,
    headers: { ...headers, host: url.host, 'accept-encoding': 'identity', accept: 'application/json' },
    agent: false,
  }, response => {
    resolve({
      status: response.statusCode ?? 502,
      ...(response.headers.location ? { location: response.headers.location } : {}),
      ...(response.headers['content-length'] ? { contentLength: response.headers['content-length'] } : {}),
      ...(response.headers['content-encoding'] ? { contentEncoding: response.headers['content-encoding'] } : {}),
      body: response, close: () => response.destroy(),
    });
  });
  outgoing.once('error', reject);
  outgoing.end();
});

export interface MetadataHttpClient {
  getJson(url: URL, headers?: Readonly<Record<string, string>>): Promise<unknown>;
}

export class MetadataIngester implements MetadataHttpClient {
  constructor(
    private readonly allowedHosts: ReadonlySet<string>,
    private readonly resolver: MetadataResolver = hostname => lookup(hostname, { all: true, verbatim: true }),
    private readonly transport: MetadataTransport = httpsMetadataTransport,
    private readonly timeoutMs = 3000,
  ) {
    if (!Number.isInteger(timeoutMs) || timeoutMs < 1 || timeoutMs > 3000) throw new Error('Metadata timeout must be at most 3000 ms');
  }

  async getJson(initialUrl: URL, headers: Readonly<Record<string, string>> = {}): Promise<unknown> {
    const signal = AbortSignal.timeout(this.timeoutMs);
    let url = new URL(initialUrl);
    try {
      for (let redirects = 0; redirects <= 3; redirects += 1) {
        if (url.protocol !== 'https:' || url.username || url.password || url.port || !this.allowedHosts.has(url.hostname)) {
          throw new IngestionError(422, 'unsafe_metadata_url');
        }
        const addresses = await abortable(this.resolver(url.hostname), signal);
        if (!addresses.length || addresses.some(address => !isPublicAddress(address.address))) {
          throw new IngestionError(422, 'unsafe_metadata_address');
        }
        const response = await abortable(this.transport(url, addresses[0]!, headers, signal), signal);
        try {
          if ([301, 302, 303, 307, 308].includes(response.status)) {
            if (!response.location || redirects === 3) throw new IngestionError(502, 'metadata_redirect_limit');
            const next = new URL(response.location, url);
            if (next.origin !== url.origin) throw new IngestionError(422, 'cross_origin_metadata_redirect');
            url = next;
            continue;
          }
          if (response.status === 404) throw new IngestionError(422, 'track_unavailable');
          if (response.status === 429) throw new IngestionError(503, 'metadata_rate_limited');
          if (response.status < 200 || response.status >= 300) throw new IngestionError(502, 'metadata_provider_error');
          if (response.contentEncoding && response.contentEncoding !== 'identity') throw new IngestionError(502, 'unsupported_metadata_encoding');
          if (response.contentLength && (!/^\d+$/.test(response.contentLength) || Number(response.contentLength) > 1048576)) {
            throw new IngestionError(502, 'metadata_too_large');
          }
          const chunks: Buffer[] = [];
          let length = 0;
          const iterator = response.body[Symbol.asyncIterator]();
          while (true) {
            const chunk = await abortable(iterator.next(), signal);
            if (chunk.done) break;
            length += chunk.value.byteLength;
            if (length > 1048576) throw new IngestionError(502, 'metadata_too_large');
            chunks.push(Buffer.from(chunk.value));
          }
          try { return JSON.parse(Buffer.concat(chunks).toString('utf8')) as unknown; }
          catch { throw new IngestionError(502, 'invalid_metadata_json'); }
        } finally { response.close(); }
      }
      throw new IngestionError(502, 'metadata_redirect_limit');
    } catch (error) {
      if (error instanceof IngestionError) throw error;
      throw new IngestionError(signal.aborted ? 504 : 502, signal.aborted ? 'metadata_timeout' : 'metadata_network_error');
    }
  }
}
