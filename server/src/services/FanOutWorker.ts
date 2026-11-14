import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { JobQueue } from '../jobs/queue.js';
import { ProviderRegistry, ProviderSyncError, type CanonicalTrack, type StreamingConnection } from '../providers/StreamingProviderAdapter.js';
import { TokenVault } from './TokenVault.js';

interface Member {
  id: string; user_id: string; group_playlist_id: string; last_synced_sequence: number;
  streaming_connection_id: string; external_playlist_id: string;
  current_sequence: number;
}
interface ConnectionRow {
  id: string; provider: string; encrypted_access_token: string; encrypted_refresh_token: string | null; storefront: string;
}
interface EventRow {
  id: string; sequence_number: number; event_type: string; canonical_track_id: string;
  isrc: string | null; normalized_title: string; normalized_artist: string; duration_ms: number;
}
interface DeliveryRow {
  id: string; status: string; attempt_count: number; connection_id: string | null; external_playlist_id: string | null; next_attempt_at: Date | null;
}

export class FanOutWorker {
  constructor(private readonly pool: Pool, private readonly queue: Pick<JobQueue, 'sendInTransaction'>,
    private readonly registry: ProviderRegistry, private readonly vault: TokenVault) {}

  async deliver(membershipId: string, throughSequence: number): Promise<void> {
    if (!Number.isSafeInteger(throughSequence) || throughSequence < 1) throw new Error('Invalid delivery sequence');
    const client = await this.pool.connect();
    const locks: string[] = [];
    let releaseError: Error | undefined;
    try {
      for (const lock of [`fanout-member:${membershipId}`]) {
        if (!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [lock])).rows[0].acquired) {
          throw new ProviderSyncError('TRANSIENT');
        }
        locks.push(lock);
      }
      const member = await this.member(client, membershipId);
      if (!member) return;
      const connectionLock = `fanout-connection:${member.streaming_connection_id}`;
      if (!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [connectionLock])).rows[0].acquired) {
        throw new ProviderSyncError('TRANSIENT');
      }
      locks.push(connectionLock);
      for (let processed = 0; processed < 20; processed += 1) {
        const current = await this.member(client, membershipId);
        if (!current) return;
        throughSequence = Math.max(throughSequence, current.current_sequence);
        if (current.last_synced_sequence >= throughSequence) return;
        if (current.streaming_connection_id !== member.streaming_connection_id) return;
        const events = await client.query<EventRow>(`SELECT event.*, track.isrc, track.normalized_title, track.normalized_artist, track.duration_ms
          FROM playlist_events event JOIN canonical_tracks track ON track.id = event.canonical_track_id
          WHERE event.group_playlist_id = $1 AND event.sequence_number = $2`, [current.group_playlist_id, current.last_synced_sequence + 1]);
        const event = events.rows[0];
        if (!event) throw new Error('Missing contiguous playlist event');
        if (!await this.execute(client, current, event, throughSequence)) return;
      }
      await this.transaction(client, async () => {
        await this.queue.sendInTransaction(client, 'deliver-membership', { membershipId, throughSequence });
      });
    } finally {
      try {
        for (const lock of locks.reverse()) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]);
      } catch { releaseError = new Error('Failed to release delivery locks'); }
      client.release(releaseError);
    }
  }

  private async member(client: PoolClient, membershipId: string): Promise<Member | undefined> {
    return (await client.query<Member>(`SELECT membership.*, playlist.current_sequence FROM playlist_memberships membership
      JOIN group_playlists playlist ON playlist.id = membership.group_playlist_id
      JOIN streaming_connections connection ON connection.id = membership.streaming_connection_id
      WHERE membership.id = $1 AND membership.status = 'active' AND connection.status = 'active'
        AND membership.external_playlist_id IS NOT NULL`, [membershipId])).rows[0];
  }

  private async execute(client: PoolClient, member: Member, event: EventRow, throughSequence: number): Promise<boolean> {
    await client.query(`INSERT INTO sync_delivery_logs (id, playlist_event_id, user_id, status)
      VALUES ($1, $2, $3, 'pending') ON CONFLICT (playlist_event_id, user_id) DO NOTHING`, [randomUUID(), event.id, member.user_id]);
    const delivery = (await client.query<DeliveryRow>('SELECT * FROM sync_delivery_logs WHERE playlist_event_id = $1 AND user_id = $2', [event.id, member.user_id])).rows[0]!;
    if (['delivered', 'skipped_unavailable'].includes(delivery.status)) {
      await this.finish(client, member, event, delivery.id, delivery.status);
      return true;
    }
    if (['needs_reconcile', 'pending_client_reconcile', 'failed_terminal'].includes(delivery.status)) return false;
    if (delivery.status === 'delivering' || (delivery.connection_id !== null && (delivery.connection_id !== member.streaming_connection_id
      || delivery.external_playlist_id !== member.external_playlist_id))) {
      await client.query("UPDATE sync_delivery_logs SET status = 'needs_reconcile', last_error = 'AMBIGUOUS_WRITE' WHERE id = $1", [delivery.id]);
      return false;
    }
    if (delivery.next_attempt_at && delivery.next_attempt_at.getTime() > Date.now()) return false;
    const row = (await client.query<ConnectionRow>('SELECT * FROM streaming_connections WHERE id = $1', [member.streaming_connection_id])).rows[0]!;
    let mutationStarted = false;
    try {
      const adapter = this.registry.get(row.provider);
      let connection: StreamingConnection = { id: row.id, storefront: row.storefront, accessToken: this.vault.decrypt(row.encrypted_access_token, row.id),
        refreshToken: row.encrypted_refresh_token ? this.vault.decrypt(row.encrypted_refresh_token, row.id) : null };
      let refreshed = false;
      const authorized = async <Result>(operation: (value: StreamingConnection) => Promise<Result>): Promise<Result> => {
        try { return await operation(connection); }
        catch (error) {
          if (!(error instanceof ProviderSyncError) || error.code !== 'TOKEN_EXPIRED' || refreshed || !adapter.refreshToken) throw error;
          refreshed = true;
          const tokens = await adapter.refreshToken(connection);
          await client.query(`UPDATE streaming_connections SET encrypted_access_token = $2, encrypted_refresh_token = $3,
            token_expires_at = now() + $4 * interval '1 second' WHERE id = $1`, [row.id, this.vault.encrypt(tokens.accessToken, row.id),
          tokens.refreshToken ? this.vault.encrypt(tokens.refreshToken, row.id) : null, tokens.expiresIn]);
          connection = { ...connection, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
          return operation(connection);
        }
      };
      const track: CanonicalTrack = { id: event.canonical_track_id, isrc: event.isrc, normalizedTitle: event.normalized_title,
        normalizedArtist: event.normalized_artist, durationMs: event.duration_ms };
      if (event.event_type === 'TRACK_REMOVED') {
        if (!adapter.capabilities.supportsServerSideDelete) {
          await client.query("UPDATE sync_delivery_logs SET status = 'pending_client_reconcile' WHERE id = $1", [delivery.id]);
          return false;
        }
        const prior = await client.query<{ provider_item_handle: string | null }>(`SELECT log.provider_item_handle FROM sync_delivery_logs log
          JOIN playlist_events addition ON addition.id = log.playlist_event_id WHERE addition.group_playlist_id = $1
          AND addition.canonical_track_id = $2 AND addition.event_type = 'TRACK_ADDED' AND addition.sequence_number < $3
          AND log.user_id = $4 AND log.status = 'delivered' AND log.connection_id = $5 AND log.external_playlist_id = $6
          ORDER BY addition.sequence_number DESC LIMIT 1`, [member.group_playlist_id, track.id, event.sequence_number, member.user_id, row.id, member.external_playlist_id]);
        const handle = prior.rows[0]?.provider_item_handle;
        if (!handle) { await this.finish(client, member, event, delivery.id, 'skipped_unavailable'); return true; }
        const cached = await this.mapping(client, track.id, row.provider, row.storefront);
        if (!cached || !adapter.removeTracks) throw new ProviderSyncError('NOT_CONFIGURED');
        if (!await this.claim(client, member, delivery.id)) return false;
        mutationStarted = true;
        await authorized(async value => {
          await this.checkWrite(client, member);
          return adapter.removeTracks!(value, member.external_playlist_id, [{ trackId: cached, handle }]);
        });
        await this.finish(client, member, event, delivery.id, 'delivered', handle);
        return true;
      }
      let trackId = await this.mapping(client, track.id, row.provider, row.storefront);
      if (!trackId) {
        trackId = await authorized(value => adapter.resolveTrackId(value, track, row.storefront));
        if (trackId) {
          await client.query(`INSERT INTO track_provider_mappings (id, canonical_track_id, provider, storefront, external_track_id)
            VALUES ($1, $2, $3, $4, $5) ON CONFLICT DO NOTHING`, [randomUUID(), track.id, row.provider, row.storefront, trackId]);
          trackId = await this.mapping(client, track.id, row.provider, row.storefront);
        }
      }
      if (!trackId) { await this.finish(client, member, event, delivery.id, 'skipped_unavailable'); return true; }
      if (!await this.claim(client, member, delivery.id)) return false;
      mutationStarted = true;
      const resolvedId = trackId;
      const result = await authorized(async value => {
        await this.checkWrite(client, member);
        return adapter.appendTracks(value, member.external_playlist_id, [resolvedId]);
      });
      if (result.length !== 1 || result[0]?.trackId !== resolvedId || !result[0].handle) throw new ProviderSyncError('AMBIGUOUS_WRITE');
      await this.finish(client, member, event, delivery.id, 'delivered', result[0].handle);
      return true;
    } catch (error) {
      const failure = error instanceof ProviderSyncError ? error : new ProviderSyncError(mutationStarted ? 'AMBIGUOUS_WRITE' : 'NOT_CONFIGURED');
      if (failure.code === 'TRACK_UNAVAILABLE') {
        await this.finish(client, member, event, delivery.id, 'skipped_unavailable');
        return true;
      }
      await this.failure(client, member, event, delivery, failure, throughSequence);
      return false;
    }
  }

  private async claim(client: PoolClient, member: Member, deliveryId: string): Promise<boolean> {
    const current = await this.member(client, member.id);
    if (!current || current.streaming_connection_id !== member.streaming_connection_id || current.external_playlist_id !== member.external_playlist_id) return false;
    await client.query(`UPDATE sync_delivery_logs SET status = 'delivering', attempt_count = attempt_count + 1,
      connection_id = $2, external_playlist_id = $3, next_attempt_at = NULL WHERE id = $1`, [deliveryId, member.streaming_connection_id, member.external_playlist_id]);
    return true;
  }

  private async checkWrite(client: PoolClient, member: Member): Promise<void> {
    const current = await this.member(client, member.id);
    if (!current || current.streaming_connection_id !== member.streaming_connection_id || current.external_playlist_id !== member.external_playlist_id) {
      throw new ProviderSyncError('MEMBERSHIP_CHANGED');
    }
  }

  private async mapping(client: PoolClient, trackId: string, provider: string, storefront: string): Promise<string | null> {
    return (await client.query<{ external_track_id: string }>(`SELECT external_track_id FROM track_provider_mappings
      WHERE canonical_track_id = $1 AND provider = $2 AND storefront = $3`, [trackId, provider, storefront])).rows[0]?.external_track_id ?? null;
  }

  private async finish(client: PoolClient, member: Member, event: EventRow, deliveryId: string, status: string, handle?: string): Promise<void> {
    await this.transaction(client, async () => {
      await client.query(`UPDATE sync_delivery_logs SET status = $2, provider_item_handle = COALESCE($3, provider_item_handle),
        delivered_at = now(), last_error = NULL, next_attempt_at = NULL WHERE id = $1`, [deliveryId, status, handle ?? null]);
      await client.query('UPDATE playlist_memberships SET last_synced_sequence = $2 WHERE id = $1 AND last_synced_sequence = $2 - 1', [member.id, event.sequence_number]);
    });
  }

  private async failure(client: PoolClient, member: Member, event: EventRow, delivery: DeliveryRow, error: ProviderSyncError, throughSequence: number) {
    await this.transaction(client, async () => {
      if (error.code === 'TOKEN_EXPIRED') {
        await client.query("UPDATE streaming_connections SET status = 'needs_reauth' WHERE id = $1", [member.streaming_connection_id]);
      }
      if (error.code === 'PLAYLIST_NOT_FOUND') {
        await client.query("UPDATE playlist_memberships SET status = 'recreating' WHERE id = $1", [member.id]);
        await this.queue.sendInTransaction(client, 'recreate-playlist', { membershipId: member.id, groupPlaylistId: member.group_playlist_id, userId: member.user_id });
      }
      const attempts = delivery.attempt_count + 1;
      const retry = ['TRANSIENT', 'RATE_LIMITED'].includes(error.code) && attempts < 5;
      const status = error.code === 'AMBIGUOUS_WRITE' ? 'needs_reconcile' : retry ? 'failed_retryable' : 'failed_terminal';
      const seconds = Math.max(error.retryAfterSeconds, Math.min(2 ** attempts, 300));
      await client.query(`UPDATE sync_delivery_logs SET status = $2, last_error = $3, attempt_count = $4,
        next_attempt_at = CASE WHEN $5 THEN now() + $6 * interval '1 second' ELSE NULL END WHERE id = $1`,
      [delivery.id, status, error.code, attempts, retry, seconds]);
      if (retry) await this.queue.sendInTransaction(client, 'deliver-membership', { membershipId: member.id, throughSequence }, seconds);
    });
  }

  private async transaction(client: PoolClient, body: () => Promise<void>): Promise<void> {
    await client.query('BEGIN');
    try { await body(); await client.query('COMMIT'); }
    catch (error) { await client.query('ROLLBACK'); throw error; }
  }
}
