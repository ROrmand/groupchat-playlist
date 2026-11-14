import { IngestionError } from './errors.js';

export type StreamingService = 'apple_music' | 'spotify' | 'youtube_music';
export interface ParsedTrackLink {
  readonly provider: StreamingService;
  readonly storefront: string;
  readonly externalTrackId: string;
  readonly url: string;
}

function parseCandidate(candidate: string): ParsedTrackLink | null {
  if (candidate.toLowerCase().startsWith('spotify:track:')) {
    const identifier = candidate.slice(14);
    return /^[A-Za-z0-9]{22}$/.test(identifier)
      ? { provider: 'spotify', storefront: 'global', externalTrackId: identifier, url: `https://open.spotify.com/track/${identifier}` }
      : null;
  }
  const rawPath = candidate.split(/[?#]/, 1)[0]!;
  if (/%2f|%5c|(?:^|\/)(?:\.|%2e){1,2}(?:\/|$)/i.test(rawPath)
    || /^https:\/\/[^/?#]*@/i.test(candidate)) return null;
  let parsed: URL;
  try { parsed = new URL(candidate); } catch { return null; }
  if (parsed.protocol !== 'https:' || parsed.username || parsed.password || (parsed.port && parsed.port !== '443')) return null;
  const host = parsed.hostname.toLowerCase();
  let path: string[];
  try { path = parsed.pathname.split('/').filter(Boolean).map(decodeURIComponent); } catch { return null; }
  if (host === 'open.spotify.com' && path.length === 2 && path[0] === 'track' && /^[A-Za-z0-9]{22}$/.test(path[1]!)) {
    return { provider: 'spotify', storefront: 'global', externalTrackId: path[1]!, url: `https://open.spotify.com/track/${path[1]}` };
  }
  if (host === 'music.apple.com' && path.length >= 3 && /^[a-zA-Z]{2}$/.test(path[0]!) && ['song', 'album'].includes(path[1]!)) {
    const identifiers = parsed.searchParams.getAll('i');
    if (identifiers.length > 1) return null;
    const identifier = identifiers[0] ?? (path[1] === 'song' ? path.at(-1) : undefined);
    if (!identifier || !/^[0-9]{1,20}$/.test(identifier)) return null;
    const storefront = path[0]!.toLowerCase();
    return { provider: 'apple_music', storefront, externalTrackId: identifier, url: `https://music.apple.com/${storefront}/song/${identifier}` };
  }
  if (['youtube.com', 'www.youtube.com', 'music.youtube.com', 'youtu.be'].includes(host)) {
    const identifiers = parsed.searchParams.getAll('v');
    if (identifiers.length > 1) return null;
    const identifier = host === 'youtu.be' && path.length === 1 ? path[0]
      : host !== 'youtu.be' && path.length === 1 && path[0] === 'watch' ? identifiers[0] : undefined;
    if (!identifier || !/^[A-Za-z0-9_-]{11}$/.test(identifier)) return null;
    return { provider: 'youtube_music', storefront: 'global', externalTrackId: identifier, url: `https://music.youtube.com/watch?v=${identifier}` };
  }
  return null;
}

export function parseChatText(input: string): ParsedTrackLink[] {
  if (Buffer.byteLength(input) > 8192) throw new IngestionError(413, 'input_too_long');
  const candidates = input.replaceAll('&amp;', '&').match(/(?:https?:\/\/|spotify:track:)[\p{L}\p{M}\p{N}\-._~:/?#\[\]@!$&'()*+,;=%]+/giu) ?? [];
  if (candidates.length > 64) throw new IngestionError(422, 'too_many_links');
  const result: ParsedTrackLink[] = [];
  for (const candidate of candidates) {
    const link = parseCandidate(candidate.replace(/[).,!;:\]}]+$/, ''));
    if (link && !result.some(previous => previous.url === link.url)) result.push(link);
  }
  return result;
}
