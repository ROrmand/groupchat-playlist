import { normalizeTrackText } from '../domain/TrackCanonicalizer.js';
import { ProviderHttp, identifier, record, rows } from './http.js';
import { refreshOAuth, jsonRequest, validateBatch, type OAuthCredentials } from './OAuth.js';
import { ProviderSyncError, type CanonicalTrack, type ProviderItemHandle, type StreamingConnection, type StreamingProviderAdapter } from './StreamingProviderAdapter.js';

export class YouTubeMusicAdapter implements StreamingProviderAdapter {
  readonly providerId = 'youtube_music';
  readonly capabilities = { supportsISRC: false, supportsServerSideDelete: true, supportsBatchAppend: false,
    maxTracksPerRequest: 1, tokenRefreshMode: 'server_oauth' as const };

  constructor(private readonly http: ProviderHttp, private readonly oauth?: OAuthCredentials) {}

  async createPlaylist(connection: StreamingConnection, name: string, description = ''): Promise<string> {
    return identifier((await this.http.request('https://www.googleapis.com/youtube/v3/playlists?part=snippet,status',
      jsonRequest('POST', connection.accessToken, { snippet: { title: name, description }, status: { privacyStatus: 'private' } }), true)).id);
  }

  async resolveTrackId(connection: StreamingConnection, track: CanonicalTrack, storefront: string): Promise<string | null> {
    const query = new URLSearchParams({ part: 'snippet', type: 'video', videoCategoryId: '10', maxResults: '10',
      regionCode: storefront.toUpperCase(), q: `${track.normalizedArtist} ${track.normalizedTitle}` });
    const result = await this.http.request(`https://www.googleapis.com/youtube/v3/search?${query}`, jsonRequest('GET', connection.accessToken));
    const ids = rows(result.items).map(item => identifier(record(item.id).videoId));
    if (!ids.length) return null;
    const details = await this.http.request(`https://www.googleapis.com/youtube/v3/videos?${new URLSearchParams({ part: 'snippet,contentDetails,status', id: ids.join(',') })}`,
      jsonRequest('GET', connection.accessToken));
    const candidates = rows(details.items).filter(item => {
      const snippet = record(item.snippet);
      const content = record(item.contentDetails);
      const status = record(item.status);
      const artist = typeof snippet.channelTitle === 'string' ? /^(.+) - Topic$/.exec(snippet.channelTitle)?.[1] : undefined;
      const duration = typeof content.duration === 'string' ? /^PT(?:(\d+)H)?(?:(\d+)M)?(?:(\d+)S)?$/.exec(content.duration) : null;
      const durationMs = duration ? (Number(duration[1] ?? 0) * 3600 + Number(duration[2] ?? 0) * 60 + Number(duration[3] ?? 0)) * 1000 : NaN;
      const restrictions = content.regionRestriction === undefined ? {} : record(content.regionRestriction);
      const country = storefront.toUpperCase();
      return artist !== undefined && normalizeTrackText(artist) === track.normalizedArtist
        && typeof snippet.title === 'string' && normalizeTrackText(snippet.title) === track.normalizedTitle
        && snippet.categoryId === '10' && snippet.liveBroadcastContent === 'none' && status.embeddable === true
        && Math.abs(durationMs - track.durationMs) <= 3000
        && (!Array.isArray(restrictions.blocked) || !restrictions.blocked.includes(country))
        && (!Array.isArray(restrictions.allowed) || restrictions.allowed.includes(country));
    });
    return candidates.length === 1 ? identifier(candidates[0]!.id) : null;
  }

  async appendTracks(connection: StreamingConnection, playlistId: string, trackIds: string[]) {
    validateBatch(trackIds, 1);
    const trackId = trackIds[0]!;
    const result = await this.http.request('https://www.googleapis.com/youtube/v3/playlistItems?part=snippet',
      jsonRequest('POST', connection.accessToken, { snippet: { playlistId, resourceId: { kind: 'youtube#video', videoId: trackId } } }), true, true);
    try { return [{ trackId, handle: identifier(result.id) }]; }
    catch { throw new ProviderSyncError('AMBIGUOUS_WRITE'); }
  }

  async removeTracks(connection: StreamingConnection, _playlistId: string, handles: ProviderItemHandle[]): Promise<void> {
    validateBatch(handles.map(item => item.trackId), 1);
    try {
      await this.http.request(`https://www.googleapis.com/youtube/v3/playlistItems?${new URLSearchParams({ id: handles[0]!.handle })}`,
        jsonRequest('DELETE', connection.accessToken), true);
    } catch (error) {
      if (!(error instanceof ProviderSyncError) || error.code !== 'TRACK_UNAVAILABLE') throw error;
    }
  }

  refreshToken(connection: StreamingConnection) { return refreshOAuth(this.http, this.providerId, connection, this.oauth); }
}
