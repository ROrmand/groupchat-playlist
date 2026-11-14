import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { parseChatText, type ParsedTrackLink } from '../domain/ChatTextParser.js';
import { canonicalizeTrack, type NormalizedTrack } from '../domain/TrackCanonicalizer.js';
import { IngestionError } from '../domain/errors.js';
import type { PlaylistEvent } from '../domain/models.js';
import type { FanOutTrackAdditionJob } from '../jobs/queue.js';
import type { TrackMetadataClient } from '../providers/metadata.js';

export interface AdditionJobPublisher {
  sendInTransaction(client: PoolClient, name: 'fan-out-track-addition', payload: FanOutTrackAdditionJob): Promise<void>;
}
export interface IngestionResult {
  readonly status: 200 | 202;
  readonly canonicalTrackId: string;
  readonly event: PlaylistEvent | null;
}

export class PlaylistIngestionService {
  constructor(private readonly pool: Pool, private readonly metadata: TrackMetadataClient, private readonly jobs: AdditionJobPublisher) {}

  async add(playlistId: string, userId: string, rawInput: string): Promise<IngestionResult> {
    const links = parseChatText(rawInput);
    if (links.length !== 1) throw new IngestionError(422, links.length ? 'multiple_tracks_not_supported' : 'unsupported_track_link');
    const link = links[0]!;
    const membership = await this.pool.query("SELECT id FROM playlist_memberships WHERE group_playlist_id = $1 AND user_id = $2 AND status = 'active'", [playlistId, userId]);
    if (!membership.rowCount) throw new IngestionError(403, 'active_membership_required');
    const cached = await this.pool.query<{ canonical_track_id: string }>(`SELECT canonical_track_id FROM track_provider_mappings
      WHERE provider = $1 AND storefront = $2 AND external_track_id = $3`, [link.provider, link.storefront, link.externalTrackId]);
    const normalized = cached.rowCount ? null : canonicalizeTrack(await this.metadata.resolve(link));
    const client = await this.pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL statement_timeout = '5s'");
      const playlist = await client.query<{ current_sequence: number }>('SELECT current_sequence FROM group_playlists WHERE id = $1 FOR UPDATE', [playlistId]);
      if (!playlist.rowCount) throw new IngestionError(403, 'active_membership_required');
      const active = await client.query(`SELECT id FROM playlist_memberships
        WHERE group_playlist_id = $1 AND user_id = $2 AND status = 'active' FOR UPDATE`, [playlistId, userId]);
      if (!active.rowCount) throw new IngestionError(403, 'active_membership_required');
      const trackId = await this.resolveCatalog(client, link, normalized);
      const duplicate = await client.query('SELECT id FROM playlist_items WHERE group_playlist_id = $1 AND canonical_track_id = $2 AND removed_at IS NULL', [playlistId, trackId]);
      if (duplicate.rowCount) {
        await client.query('COMMIT');
        return { status: 200, canonicalTrackId: trackId, event: null };
      }
      const sequenceNumber = playlist.rows[0]!.current_sequence + 1;
      const event: PlaylistEvent = {
        id: randomUUID(), groupPlaylistId: playlistId, sequenceNumber, eventType: 'TRACK_ADDED',
        canonicalTrackId: trackId, actorUserId: userId, createdAt: new Date().toISOString(),
      };
      await client.query(`INSERT INTO playlist_items (id, group_playlist_id, canonical_track_id, added_by_user_id, position)
        VALUES ($1, $2, $3, $4, $5)`, [randomUUID(), playlistId, trackId, userId, sequenceNumber]);
      await client.query(`INSERT INTO playlist_events (id, group_playlist_id, sequence_number, event_type, canonical_track_id, actor_user_id, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [event.id, playlistId, sequenceNumber, event.eventType, trackId, userId, event.createdAt]);
      await client.query('UPDATE group_playlists SET current_sequence = $2 WHERE id = $1', [playlistId, sequenceNumber]);
      await this.jobs.sendInTransaction(client, 'fan-out-track-addition', { eventId: event.id, groupPlaylistId: playlistId, canonicalTrackId: trackId });
      await client.query('COMMIT');
      return { status: 202, canonicalTrackId: trackId, event };
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
  }

  private async resolveCatalog(client: PoolClient, link: ParsedTrackLink, track: NormalizedTrack | null): Promise<string> {
    const existing = await client.query<{ canonical_track_id: string }>(`SELECT canonical_track_id FROM track_provider_mappings
      WHERE provider = $1 AND storefront = $2 AND external_track_id = $3`, [link.provider, link.storefront, link.externalTrackId]);
    if (existing.rows[0]) return existing.rows[0].canonical_track_id;
    if (!track) throw new IngestionError(503, 'catalog_mapping_changed');
    const locks = [`name:${track.normalizedTitle}::${track.normalizedArtist}`, ...(track.isrc ? [`isrc:${track.isrc}`] : [])].sort();
    for (const lock of locks) await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [lock]);
    const byIsrc = track.isrc ? await client.query<{ id: string }>('SELECT id FROM canonical_tracks WHERE isrc = $1', [track.isrc]) : null;
    let trackId = byIsrc?.rows[0]?.id;
    if (!trackId) {
      const matches = await client.query<{ id: string; isrc: string | null }>(`SELECT id, isrc FROM canonical_tracks
        WHERE normalized_title = $1 AND normalized_artist = $2
          AND duration_ms BETWEEN $3::bigint - 3000 AND $3::bigint + 3000
          AND ($4::text IS NULL OR isrc IS NULL OR isrc = $4)
        ORDER BY abs(duration_ms::bigint - $3::bigint), id LIMIT 2 FOR UPDATE`,
      [track.normalizedTitle, track.normalizedArtist, track.durationMs, track.isrc]);
      if (matches.rows.length > 1) throw new IngestionError(422, 'ambiguous_recording');
      trackId = matches.rows[0]?.id;
      if (trackId && track.isrc && !matches.rows[0]!.isrc) {
        await client.query('UPDATE canonical_tracks SET isrc = $2 WHERE id = $1', [trackId, track.isrc]);
      }
    }
    if (!trackId) {
      trackId = randomUUID();
      await client.query(`INSERT INTO canonical_tracks (id, isrc, normalized_title, normalized_artist, fallback_dedup_key, album, duration_ms)
        VALUES ($1, $2, $3, $4, $5, $6, $7)`, [trackId, track.isrc, track.normalizedTitle, track.normalizedArtist, track.fallbackDedupKey, track.album, track.durationMs]);
    }
    const mapping = await client.query<{ canonical_track_id: string }>(`INSERT INTO track_provider_mappings (id, canonical_track_id, provider, storefront, external_track_id)
      VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING RETURNING canonical_track_id`,
    [randomUUID(), trackId, link.provider, link.storefront, link.externalTrackId]);
    if (!mapping.rowCount) {
      const claimed = await client.query<{ canonical_track_id: string }>(`SELECT canonical_track_id FROM track_provider_mappings
        WHERE provider = $1 AND storefront = $2 AND external_track_id = $3`, [link.provider, link.storefront, link.externalTrackId]);
      if (claimed.rows[0] && claimed.rows[0].canonical_track_id !== trackId) throw new IngestionError(409, 'catalog_mapping_conflict');
    }
    return trackId;
  }
}
