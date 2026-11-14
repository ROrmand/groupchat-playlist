import type { CanonicalTrack } from '../domain/models.js';

export interface MusicCatalogProvider {
  resolveTrack(url: string, storefront: string): Promise<CanonicalTrack | null>;
  searchTracks(title: string, artist: string, storefront: string): Promise<readonly CanonicalTrack[]>;
  isrc(externalTrackId: string, storefront: string): Promise<string | null>;
}
