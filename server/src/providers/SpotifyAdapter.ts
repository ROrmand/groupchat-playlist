import { normalizeTrackText } from '../domain/TrackCanonicalizer.js';
import { ProviderHttp, identifier, record, rows } from './http.js';
import { refreshOAuth, jsonRequest, validateBatch, type OAuthCredentials } from './OAuth.js';
import type { CanonicalTrack, ProviderItemHandle, StreamingConnection, StreamingProviderAdapter } from './StreamingProviderAdapter.js';

export class SpotifyAdapter implements StreamingProviderAdapter {
  readonly providerId = 'spotify';
  readonly capabilities = { supportsISRC: true, supportsServerSideDelete: true, supportsBatchAppend: true,
    maxTracksPerRequest: 100, tokenRefreshMode: 'server_oauth' as const };

  constructor(private readonly http: ProviderHttp, private readonly oauth?: OAuthCredentials) {}

  async createPlaylist(connection: StreamingConnection, name: string, description = ''): Promise<string> {
    return identifier((await this.http.request('https://api.spotify.com/v1/me/playlists',
      jsonRequest('POST', connection.accessToken, { name, description, public: false }), true)).id);
  }

  async resolveTrackId(connection: StreamingConnection, track: CanonicalTrack, storefront: string): Promise<string | null> {
    const query = new URLSearchParams({ q: track.isrc ? `isrc:${track.isrc}` : `track:${track.normalizedTitle} artist:${track.normalizedArtist}`,
      type: 'track', market: storefront.toUpperCase(), limit: '10' });
    const result = await this.http.request(`https://api.spotify.com/v1/search?${query}`, jsonRequest('GET', connection.accessToken));
    const candidates = rows(record(result.tracks).items).filter(song => {
      if (song.is_playable === false) return false;
      const isrc = song.external_ids === undefined ? null : record(song.external_ids).isrc;
      if (track.isrc) return typeof isrc === 'string' && isrc.toUpperCase() === track.isrc;
      return typeof song.name === 'string' && normalizeTrackText(song.name) === track.normalizedTitle
        && rows(song.artists).some(artist => typeof artist.name === 'string' && normalizeTrackText(artist.name) === track.normalizedArtist)
        && typeof song.duration_ms === 'number' && Math.abs(song.duration_ms - track.durationMs) <= 3000;
    });
    return candidates.length === 1 ? identifier(candidates[0]!.id) : null;
  }

  async appendTracks(connection: StreamingConnection, playlistId: string, trackIds: string[]) {
    validateBatch(trackIds, 100);
    await this.http.request(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`,
      jsonRequest('POST', connection.accessToken, { uris: trackIds.map(trackId => `spotify:track:${trackId}`) }), true, true);
    return trackIds.map(trackId => ({ trackId, handle: `spotify:track:${trackId}` }));
  }

  async removeTracks(connection: StreamingConnection, playlistId: string, handles: ProviderItemHandle[]): Promise<void> {
    validateBatch(handles.map(item => item.trackId), 100);
    await this.http.request(`https://api.spotify.com/v1/playlists/${encodeURIComponent(playlistId)}/items`,
      jsonRequest('DELETE', connection.accessToken, { items: handles.map(item => ({ uri: item.handle })) }), true, true);
  }

  refreshToken(connection: StreamingConnection) { return refreshOAuth(this.http, this.providerId, connection, this.oauth); }
}
