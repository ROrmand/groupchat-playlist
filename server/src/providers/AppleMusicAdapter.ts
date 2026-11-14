import { importPKCS8, SignJWT } from 'jose';
import { normalizeTrackText } from '../domain/TrackCanonicalizer.js';
import { ProviderHttp, identifier, record, rows } from './http.js';
import { validateBatch } from './OAuth.js';
import { ProviderSyncError, type CanonicalTrack, type StreamingConnection, type StreamingProviderAdapter } from './StreamingProviderAdapter.js';

export interface AppleSigningConfig { teamId: string; keyId: string; privateKey: string }

export function appleDeveloperToken(config: AppleSigningConfig): () => Promise<string> {
  let cached: { token: string; expires: number } | undefined;
  return async () => {
    if (cached && cached.expires > Date.now() + 60000) return cached.token;
    const key = await importPKCS8(config.privateKey.replaceAll('\\n', '\n'), 'ES256');
    const token = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: config.keyId })
      .setIssuer(config.teamId).setIssuedAt().setExpirationTime('1h').sign(key);
    cached = { token, expires: Date.now() + 3600000 };
    return token;
  };
}

export class AppleMusicAdapter implements StreamingProviderAdapter {
  readonly providerId = 'apple_music';
  readonly capabilities = { supportsISRC: true, supportsServerSideDelete: false, supportsBatchAppend: true,
    maxTracksPerRequest: 100, tokenRefreshMode: 'on_device_sdk' as const };

  constructor(private readonly http: ProviderHttp, private readonly developerToken: () => Promise<string>) {}

  private async request(connection: StreamingConnection, path: string, method = 'GET', body?: unknown, playlist = false) {
    const token = await this.developerToken();
    if (!token) throw new ProviderSyncError('NOT_CONFIGURED');
    return this.http.request(`https://api.music.apple.com/v1/${path}`, { method,
      headers: { authorization: `Bearer ${token}`, 'music-user-token': connection.accessToken, 'content-type': 'application/json' },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }) }, method !== 'GET', playlist);
  }

  async createPlaylist(connection: StreamingConnection, name: string, description = ''): Promise<string> {
    const result = await this.request(connection, 'me/library/playlists', 'POST', { attributes: { name, description } });
    return identifier(rows(result.data)[0]?.id);
  }

  async resolveTrackId(connection: StreamingConnection, track: CanonicalTrack, storefront: string): Promise<string | null> {
    const path = `catalog/${encodeURIComponent(storefront)}`;
    const query = track.isrc ? new URLSearchParams({ 'filter[isrc]': track.isrc })
      : new URLSearchParams({ term: `${track.normalizedTitle} ${track.normalizedArtist}`, types: 'songs', limit: '10' });
    const result = await this.request(connection, `${path}/${track.isrc ? 'songs' : 'search'}?${query}`);
    const data = track.isrc ? result.data : record(record(result.results).songs).data;
    const candidates = rows(data).filter(song => {
      const attributes = record(song.attributes);
      if (track.isrc) return attributes.isrc === track.isrc;
      return typeof attributes.name === 'string' && normalizeTrackText(attributes.name) === track.normalizedTitle
        && typeof attributes.artistName === 'string' && normalizeTrackText(attributes.artistName) === track.normalizedArtist
        && typeof attributes.durationInMillis === 'number' && Math.abs(attributes.durationInMillis - track.durationMs) <= 3000;
    });
    return candidates.length === 1 ? identifier(candidates[0]!.id) : null;
  }

  async appendTracks(connection: StreamingConnection, playlistId: string, trackIds: string[]) {
    validateBatch(trackIds, 100);
    await this.request(connection, `me/library/playlists/${encodeURIComponent(playlistId)}/tracks`, 'POST',
      { data: trackIds.map(trackId => ({ id: trackId, type: 'songs' })) }, true);
    return trackIds.map(trackId => ({ trackId, handle: trackId }));
  }
}
