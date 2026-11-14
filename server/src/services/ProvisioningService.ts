import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IngestionError } from '../domain/errors.js';
import type { JobQueue } from '../jobs/queue.js';
import { ProviderRegistry, ProviderSyncError, type StreamingConnection, type StreamingProviderAdapter } from '../providers/StreamingProviderAdapter.js';
import { TokenVault } from './TokenVault.js';
import { idempotent, transaction } from './onboardingSupport.js';

interface Attempt {
  id: string; membership_id: string; connection_id: string; status: string; attempt_count: number;
  next_attempt_at: Date | null; external_playlist_id: string | null;
}

export class ProvisioningService {
  constructor(private readonly pool: Pool, private readonly queue: Pick<JobQueue, 'sendInTransaction'>,
    private readonly registry: ProviderRegistry, private readonly vault: TokenVault) {}

  async start(userId: string, membershipId: string, connectionId: string, key: string) {
    return transaction(this.pool, client => idempotent(client, userId, `provision:${membershipId}`, key, { connectionId }, async () => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`fanout-member:${membershipId}`]);
      const member = (await client.query(`SELECT * FROM playlist_memberships WHERE id = $1 AND user_id = $2 FOR UPDATE`, [membershipId, userId])).rows[0];
      if (!member) throw new IngestionError(404, 'membership_not_found');
      const connection = (await client.query(`SELECT provider FROM streaming_connections WHERE id = $1 AND user_id = $2 AND status = 'active'`, [connectionId, userId])).rows[0];
      if (!connection) throw new IngestionError(409, 'active_connection_required');
      this.registry.get(connection.provider as string);
      const unresolved = (await client.query(`SELECT id, connection_id, status FROM provisioning_attempts
        WHERE membership_id = $1 AND status IN ('pending', 'creating', 'failed_retryable', 'needs_reconcile')`, [membershipId])).rows[0];
      if (unresolved) {
        if (unresolved.connection_id !== connectionId || unresolved.status === 'needs_reconcile') throw new IngestionError(409, 'provisioning_requires_reconcile');
        return { attemptId: unresolved.id as string };
      }
      if (!['invited', 'provisioning', 'paused'].includes(member.status as string) || member.external_playlist_id) {
        throw new IngestionError(409, 'membership_already_provisioned');
      }
      const attemptId = randomUUID();
      await client.query(`UPDATE playlist_memberships SET status = 'provisioning', streaming_connection_id = $2 WHERE id = $1`, [membershipId, connectionId]);
      await client.query(`INSERT INTO provisioning_attempts (id, membership_id, connection_id, status) VALUES ($1, $2, $3, 'pending')`, [attemptId, membershipId, connectionId]);
      await this.queue.sendInTransaction(client, 'provision-membership', { attemptId });
      return { attemptId };
    }));
  }

  async status(userId: string, membershipId: string) {
    const member = (await this.pool.query(`SELECT id, status, streaming_connection_id AS "connectionId",
      external_playlist_id AS "externalPlaylistId", provisioned_at_sequence AS "provisionedAtSequence",
      last_synced_sequence AS "lastSyncedSequence" FROM playlist_memberships WHERE id = $1 AND user_id = $2`, [membershipId, userId])).rows[0];
    if (!member) throw new IngestionError(404, 'membership_not_found');
    const attempt = (await this.pool.query(`SELECT id, status, attempt_count AS "attemptCount", last_error AS "lastError",
      external_playlist_id AS "externalPlaylistId" FROM provisioning_attempts WHERE membership_id = $1 ORDER BY created_at DESC, id DESC LIMIT 1`, [membershipId])).rows[0];
    return { ...member, attempt: attempt ?? null, historicalBackfill: member.provisionedAtSequence === null ? 'not_provisioned' : 'deferred_sprint_6' };
  }

  async deliver(attemptId: string): Promise<void> {
    const client = await this.pool.connect();
    const locks: string[] = [];
    let releaseError: Error | undefined;
    try {
      let attempt = (await client.query<Attempt>('SELECT * FROM provisioning_attempts WHERE id = $1', [attemptId])).rows[0];
      if (!attempt) return;
      for (const lock of [`fanout-member:${attempt.membership_id}`, `fanout-connection:${attempt.connection_id}`]) {
        if (!(await client.query('SELECT pg_try_advisory_lock(hashtextextended($1, 0)) AS acquired', [lock])).rows[0].acquired) throw new ProviderSyncError('TRANSIENT');
        locks.push(lock);
      }
      attempt = (await client.query<Attempt>('SELECT * FROM provisioning_attempts WHERE id = $1', [attemptId])).rows[0]!;
      if (attempt.status === 'creating') {
        await this.failure(client, attempt, 'needs_reconcile', 'ABANDONED_CREATE');
        return;
      }
      if (!['pending', 'failed_retryable'].includes(attempt.status)) return;
      if (attempt.next_attempt_at && attempt.next_attempt_at.getTime() > Date.now()) return;
      const current = await this.eligible(client, attempt);
      if (!current) { await this.failure(client, attempt, 'failed_terminal', 'MEMBERSHIP_CHANGED'); return; }
      let adapter: StreamingProviderAdapter;
      let connection: StreamingConnection;
      try {
        adapter = this.registry.get(current.provider as string);
        connection = { id: attempt.connection_id,
          accessToken: this.vault.decrypt(current.encrypted_access_token as string, attempt.connection_id),
          refreshToken: current.encrypted_refresh_token ? this.vault.decrypt(current.encrypted_refresh_token as string, attempt.connection_id) : null,
          storefront: current.storefront as string };
      } catch { await this.failure(client, attempt, 'failed_terminal', 'NOT_CONFIGURED'); return; }
      let creating = false;
      let refreshing = false;
      try {
        const refresh = async () => {
          if (!adapter.refreshToken || adapter.capabilities.tokenRefreshMode !== 'server_oauth') throw new ProviderSyncError('TOKEN_EXPIRED');
          refreshing = true;
          const tokens = await adapter.refreshToken(connection);
          await client.query(`UPDATE streaming_connections SET encrypted_access_token = $2, encrypted_refresh_token = $3,
            token_expires_at = now() + $4 * interval '1 second' WHERE id = $1`, [connection.id,
          this.vault.encrypt(tokens.accessToken, connection.id), tokens.refreshToken ? this.vault.encrypt(tokens.refreshToken, connection.id) : null, tokens.expiresIn]);
          connection = { ...connection, accessToken: tokens.accessToken, refreshToken: tokens.refreshToken };
          refreshing = false;
        };
        if (current.token_expires_at && new Date(current.token_expires_at as string).getTime() <= Date.now()) await refresh();
        if (!await this.eligible(client, attempt)) throw new ProviderSyncError('MEMBERSHIP_CHANGED');
        await client.query(`UPDATE provisioning_attempts SET status = 'creating', attempt_count = attempt_count + 1,
          updated_at = now(), next_attempt_at = NULL WHERE id = $1`, [attempt.id]);
        creating = true;
        attempt.attempt_count += 1;
        let externalId: string;
        try { externalId = await adapter.createPlaylist(connection, current.name as string, 'Managed by Baton'); }
        catch (error) {
          if (!(error instanceof ProviderSyncError) || error.code !== 'TOKEN_EXPIRED') throw error;
          await refresh();
          if (!await this.eligible(client, attempt)) throw new ProviderSyncError('MEMBERSHIP_CHANGED');
          externalId = await adapter.createPlaylist(connection, current.name as string, 'Managed by Baton');
        }
        if (!externalId || externalId.length > 2048) throw new ProviderSyncError('AMBIGUOUS_WRITE');
        await client.query('UPDATE provisioning_attempts SET external_playlist_id = $2 WHERE id = $1', [attempt.id, externalId]);
        await client.query('BEGIN');
        try {
          const group = (await client.query(`SELECT playlist.id, playlist.current_sequence FROM group_playlists playlist
            JOIN playlist_memberships member ON member.group_playlist_id = playlist.id WHERE member.id = $1 FOR UPDATE OF playlist`, [attempt.membership_id])).rows[0]!;
          const valid = await this.eligible(client, attempt, true);
          if (!valid) throw new ProviderSyncError('AMBIGUOUS_WRITE');
          await client.query(`UPDATE playlist_memberships SET status = 'active', external_playlist_id = $2,
            provisioned_at_sequence = $3, last_synced_sequence = $3 WHERE id = $1`, [attempt.membership_id, externalId, group.current_sequence]);
          await client.query(`UPDATE provisioning_attempts SET status = 'succeeded', last_error = NULL, updated_at = now() WHERE id = $1`, [attempt.id]);
          await client.query('COMMIT');
        } catch (error) { await client.query('ROLLBACK'); throw error; }
      } catch (error) {
        const originalCode = error instanceof ProviderSyncError ? error.code : 'AMBIGUOUS_WRITE';
        const code = refreshing && originalCode !== 'RATE_LIMITED' ? 'TOKEN_EXPIRED' : originalCode;
        if (code === 'TOKEN_EXPIRED') await client.query(`UPDATE streaming_connections SET status = 'needs_reauth' WHERE id = $1`, [connection.id]);
        const safe = ['TOKEN_EXPIRED', 'FORBIDDEN', 'NOT_CONFIGURED', 'MEMBERSHIP_CHANGED', 'RATE_LIMITED'].includes(code);
        if (!creating) attempt.attempt_count += 1;
        const retry = (code === 'RATE_LIMITED' || (!creating && code === 'TRANSIENT')) && attempt.attempt_count < 5;
        if (retry) {
          const delaySeconds = Math.min(86400, Math.max(2 ** attempt.attempt_count,
            error instanceof ProviderSyncError ? error.retryAfterSeconds : 0));
          await client.query('BEGIN');
          try {
            await client.query(`UPDATE provisioning_attempts SET status = 'failed_retryable', attempt_count = $2,
              last_error = $3, next_attempt_at = now() + $4 * interval '1 second', updated_at = now() WHERE id = $1`,
            [attempt.id, attempt.attempt_count, code, delaySeconds]);
            await this.queue.sendInTransaction(client, 'provision-membership', { attemptId }, delaySeconds);
            await client.query('COMMIT');
          } catch (failure) { await client.query('ROLLBACK'); throw failure; }
        } else await this.failure(client, attempt, creating && !safe ? 'needs_reconcile' : 'failed_terminal', code);
      }
    } finally {
      try { for (const lock of locks.reverse()) await client.query('SELECT pg_advisory_unlock(hashtextextended($1, 0))', [lock]); }
      catch { releaseError = new Error('Failed to release provisioning locks'); }
      client.release(releaseError);
    }
  }

  private async eligible(client: PoolClient, attempt: Attempt, lock = false) {
    return (await client.query(`SELECT connection.*, playlist.name FROM playlist_memberships member
      JOIN streaming_connections connection ON connection.id = member.streaming_connection_id AND connection.user_id = member.user_id
      JOIN group_playlists playlist ON playlist.id = member.group_playlist_id
      WHERE member.id = $1 AND member.status = 'provisioning' AND connection.id = $2 AND connection.status = 'active'
        AND member.external_playlist_id IS NULL${lock ? ' FOR UPDATE OF member, connection' : ''}`, [attempt.membership_id, attempt.connection_id])).rows[0];
  }

  private async failure(client: PoolClient, attempt: Attempt, status: string, code: string) {
    await client.query(`UPDATE provisioning_attempts SET status = $2, last_error = $3, attempt_count = $4, updated_at = now() WHERE id = $1`, [attempt.id, status, code, attempt.attempt_count]);
  }
}
