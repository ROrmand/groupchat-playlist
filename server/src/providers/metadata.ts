import type { ParsedTrackLink } from '../domain/ChatTextParser.js';
import type { TrackMetadata } from '../domain/TrackCanonicalizer.js';
import { IngestionError } from '../domain/errors.js';
import type { MetadataHttpClient } from '../services/MetadataIngester.js';

export interface TrackMetadataClient {
  resolve(link: ParsedTrackLink): Promise<TrackMetadata>;
}
export interface MetadataCredentials {
  appleDeveloperToken?: string;
  spotifyAccessToken?: string;
  youtubeApiKey?: string;
}

function object(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new IngestionError(422, 'unresolvable_metadata');
  return value as Record<string, unknown>;
}

function text(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) throw new IngestionError(422, 'unresolvable_metadata');
  return value;
}

function duration(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) throw new IngestionError(422, 'unresolvable_metadata');
  return value;
}

function first(value: unknown): Record<string, unknown> {
  if (!Array.isArray(value) || !value.length) throw new IngestionError(422, 'track_unavailable');
  return object(value[0]);
}

export class ProviderMetadataClient implements TrackMetadataClient {
  constructor(private readonly http: MetadataHttpClient, private readonly credentials: MetadataCredentials) {}

  async resolve(link: ParsedTrackLink): Promise<TrackMetadata> {
    if (link.provider === 'apple_music') {
      const token = this.credentials.appleDeveloperToken;
      if (!token) throw new IngestionError(503, 'apple_metadata_not_configured');
      const result = object(await this.http.getJson(new URL(`https://api.music.apple.com/v1/catalog/${link.storefront}/songs/${link.externalTrackId}`), { authorization: `Bearer ${token}` }));
      const song = first(result.data);
      if (song.id !== link.externalTrackId) throw new IngestionError(422, 'metadata_id_mismatch');
      const attributes = object(song.attributes);
      return {
        title: text(attributes.name), artist: text(attributes.artistName),
        album: attributes.albumName === undefined ? null : text(attributes.albumName),
        durationMs: duration(attributes.durationInMillis), isrc: attributes.isrc === undefined ? null : text(attributes.isrc),
      };
    }
    if (link.provider === 'spotify') {
      const token = this.credentials.spotifyAccessToken;
      if (!token) throw new IngestionError(503, 'spotify_metadata_not_configured');
      const song = object(await this.http.getJson(new URL(`https://api.spotify.com/v1/tracks/${link.externalTrackId}`), { authorization: `Bearer ${token}` }));
      if (song.id !== link.externalTrackId) throw new IngestionError(422, 'metadata_id_mismatch');
      if (!Array.isArray(song.artists) || !song.artists.length) throw new IngestionError(422, 'unresolvable_metadata');
      const identifiers = song.external_ids === undefined ? {} : object(song.external_ids);
      return {
        title: text(song.name), artist: song.artists.map(artist => text(object(artist).name)).join(', '),
        album: song.album === undefined ? null : text(object(song.album).name),
        durationMs: duration(song.duration_ms), isrc: identifiers.isrc === undefined ? null : text(identifiers.isrc),
      };
    }
    const key = this.credentials.youtubeApiKey;
    if (!key) throw new IngestionError(503, 'youtube_metadata_not_configured');
    const url = new URL('https://www.googleapis.com/youtube/v3/videos');
    url.search = new URLSearchParams({ part: 'snippet,contentDetails', id: link.externalTrackId, key }).toString();
    const video = first(object(await this.http.getJson(url)).items);
    if (video.id !== link.externalTrackId) throw new IngestionError(422, 'metadata_id_mismatch');
    const snippet = object(video.snippet);
    const artist = /^(.+) - Topic$/.exec(text(snippet.channelTitle))?.[1];
    if (!artist || snippet.categoryId !== '10' || snippet.liveBroadcastContent !== 'none') {
      throw new IngestionError(422, 'unverified_youtube_recording');
    }
    const match = /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(text(object(video.contentDetails).duration));
    if (!match) throw new IngestionError(422, 'unresolvable_metadata');
    const durationMs = (Number(match[1] ?? 0) * 3600 + Number(match[2] ?? 0) * 60 + Number(match[3] ?? 0)) * 1000;
    return { title: text(snippet.title), artist, album: null, durationMs: duration(durationMs), isrc: null };
  }
}
