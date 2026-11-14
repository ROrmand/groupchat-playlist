import type { CanonicalTrack } from '../src/domain/models.js';
import type { MusicCatalogProvider } from '../src/providers/catalog.js';

export const trackFixture: CanonicalTrack = Object.freeze({
  id: '00000000-0000-0000-0000-000000000001',
  isrc: 'USAAA2300001', title: 'Test Song', artist: 'Test Artist', album: 'Test Album',
  durationMs: 180000, fallbackDedupKey: 'test song|test artist|60',
});

export class MockMusicCatalogProvider implements MusicCatalogProvider {
  async resolveTrack(): Promise<CanonicalTrack> { return trackFixture; }
  async searchTracks(title: string, artist: string): Promise<readonly CanonicalTrack[]> {
    return title === trackFixture.title && artist === trackFixture.artist ? [trackFixture] : [];
  }
  async isrc(): Promise<string | null> { return trackFixture.isrc; }
}
