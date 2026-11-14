import { IngestionError } from './errors.js';

export interface TrackMetadata {
  readonly title: string;
  readonly artist: string;
  readonly album: string | null;
  readonly durationMs: number;
  readonly isrc: string | null;
}
export interface NormalizedTrack extends TrackMetadata {
  readonly normalizedTitle: string;
  readonly normalizedArtist: string;
  readonly fallbackDedupKey: string;
}

export function normalizeTrackText(value: string): string {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase()
    .replace(/\([^)]*(?:\bfeat\.?|\bdeluxe(?: edition)?|\bremaster(?:ed)?)[^)]*\)|\[[^\]]*(?:\bfeat\.?|\bdeluxe(?: edition)?|\bremaster(?:ed)?)[^\]]*\]/g, ' ')
    .replace(/[^\p{L}\p{N}]+/gu, ' ').trim().replace(/\s+/g, ' ');
}

export function canonicalizeTrack(metadata: TrackMetadata): NormalizedTrack {
  if (typeof metadata.title !== 'string' || typeof metadata.artist !== 'string'
    || metadata.title.length > 1000 || metadata.artist.length > 1000
    || (metadata.isrc !== null && typeof metadata.isrc !== 'string')
    || (metadata.album !== null && (typeof metadata.album !== 'string' || metadata.album.length > 1000))
    || !Number.isSafeInteger(metadata.durationMs) || metadata.durationMs <= 0 || metadata.durationMs > 2147483647) {
    throw new IngestionError(422, 'invalid_track_metadata');
  }
  const normalizedTitle = normalizeTrackText(metadata.title);
  const normalizedArtist = normalizeTrackText(metadata.artist);
  const isrc = metadata.isrc?.replaceAll('-', '').toUpperCase() ?? null;
  if (!normalizedTitle || !normalizedArtist || (isrc !== null && !/^[A-Z]{2}[A-Z0-9]{3}\d{7}$/.test(isrc))) {
    throw new IngestionError(422, 'invalid_track_metadata');
  }
  const bucket = Math.round(metadata.durationMs / 3000);
  const fallbackDedupKey = `${normalizedTitle}::${normalizedArtist}::${bucket}${isrc ? `::isrc:${isrc}` : ''}`;
  return { ...metadata, isrc, normalizedTitle, normalizedArtist, fallbackDedupKey };
}
