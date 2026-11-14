export interface StreamingConnection {
  id: string;
  accessToken: string;
  refreshToken: string | null;
  storefront: string;
}

export interface CanonicalTrack {
  id: string;
  isrc: string | null;
  normalizedTitle: string;
  normalizedArtist: string;
  durationMs: number;
}

export interface ProviderItemHandle { trackId: string; handle: string }
export interface ProviderAppendResult { trackId: string; handle: string }
export interface TokenRefreshResult { accessToken: string; refreshToken: string | null; expiresIn: number }

export interface StreamingProviderAdapter {
  readonly providerId: string;
  readonly capabilities: {
    supportsISRC: boolean;
    supportsServerSideDelete: boolean;
    supportsBatchAppend: boolean;
    maxTracksPerRequest: number;
    tokenRefreshMode: 'server_oauth' | 'on_device_sdk';
  };
  createPlaylist(connection: StreamingConnection, name: string, description?: string): Promise<string>;
  resolveTrackId(connection: StreamingConnection, track: CanonicalTrack, storefront: string): Promise<string | null>;
  appendTracks(connection: StreamingConnection, playlistId: string, trackIds: string[]): Promise<ProviderAppendResult[]>;
  removeTracks?(connection: StreamingConnection, playlistId: string, handles: ProviderItemHandle[]): Promise<void>;
  refreshToken?(connection: StreamingConnection): Promise<TokenRefreshResult>;
}

export type ProviderErrorCode = 'TOKEN_EXPIRED' | 'PLAYLIST_NOT_FOUND' | 'RATE_LIMITED' | 'TRANSIENT'
  | 'TRACK_UNAVAILABLE' | 'FORBIDDEN' | 'INVALID_RESPONSE' | 'NOT_CONFIGURED' | 'AMBIGUOUS_WRITE' | 'MEMBERSHIP_CHANGED';

export class ProviderSyncError extends Error {
  constructor(readonly code: ProviderErrorCode, readonly retryAfterSeconds = 0) { super(code); }
}

export class ProviderRegistry {
  private readonly adapters = new Map<string, StreamingProviderAdapter>();

  register(adapter: StreamingProviderAdapter): this {
    if (this.adapters.has(adapter.providerId)) throw new Error('Provider already registered');
    this.adapters.set(adapter.providerId, adapter);
    return this;
  }

  get(providerId: string): StreamingProviderAdapter {
    const adapter = this.adapters.get(providerId);
    if (!adapter) throw new ProviderSyncError('NOT_CONFIGURED');
    return adapter;
  }
}
