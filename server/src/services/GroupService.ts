import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import { IngestionError } from '../domain/errors.js';
import { TokenVault } from './TokenVault.js';
import { digest, idempotent, secret, transaction } from './onboardingSupport.js';

export class GroupService {
  constructor(private readonly pool: Pool, private readonly vault: TokenVault) {}

  async create(userId: string, name: string, key: string) {
    return transaction(this.pool, client => idempotent(client, userId, 'create-group', key, { name }, async () => {
      const groupId = randomUUID();
      const membershipId = randomUUID();
      await client.query(`INSERT INTO group_playlists (id, name, owner_id, invite_code) VALUES ($1, $2, $3, $4)`,
        [groupId, name, userId, digest(secret())]);
      await client.query(`INSERT INTO playlist_memberships (id, group_playlist_id, user_id, status) VALUES ($1, $2, $3, 'invited')`,
        [membershipId, groupId, userId]);
      return { groupId, membershipId, status: 'invited' };
    }));
  }

  private async owner(client: PoolClient, userId: string, groupId: string) {
    const result = await client.query('SELECT id FROM group_playlists WHERE id = $1 AND owner_id = $2', [groupId, userId]);
    if (!result.rowCount) throw new IngestionError(404, 'group_not_found');
  }

  async invite(userId: string, groupId: string, key: string) {
    const saved = await transaction(this.pool, async client => {
      await this.owner(client, userId, groupId);
      return idempotent(client, userId, `invite:${groupId}`, key, {}, async () => {
        const inviteId = randomUUID();
        const token = this.vault.deriveInviteToken(inviteId);
        const expiresAt = new Date(Date.now() + 7 * 86400000).toISOString();
        await client.query(`INSERT INTO playlist_invites (id, group_playlist_id, token_hash, expires_at, created_by)
          VALUES ($1, $2, $3, $4, $5)`, [inviteId, groupId, digest(token), expiresAt, userId]);
        return { inviteId, expiresAt };
      });
    });
    return { inviteId: saved.inviteId, token: this.vault.deriveInviteToken(saved.inviteId), expiresAt: saved.expiresAt };
  }

  async revoke(userId: string, groupId: string, inviteId: string) {
    return transaction(this.pool, async client => {
      await this.owner(client, userId, groupId);
      const result = await client.query('UPDATE playlist_invites SET revoked_at = now() WHERE id = $1 AND group_playlist_id = $2', [inviteId, groupId]);
      if (!result.rowCount) throw new IngestionError(404, 'invite_not_found');
      return { revoked: true };
    });
  }

  async preview(token: string) {
    const row = (await this.pool.query(`SELECT playlist.name FROM playlist_invites invite
      JOIN group_playlists playlist ON playlist.id = invite.group_playlist_id
      WHERE invite.token_hash = $1 AND invite.revoked_at IS NULL AND invite.expires_at > now()`, [digest(token)])).rows[0];
    if (!row) throw new IngestionError(404, 'invite_not_found');
    return { name: row.name as string };
  }

  async accept(userId: string, token: string) {
    return transaction(this.pool, async client => {
      const invite = (await client.query(`SELECT id, group_playlist_id FROM playlist_invites
        WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > now() FOR UPDATE`, [digest(token)])).rows[0];
      if (!invite) throw new IngestionError(404, 'invite_not_found');
      const member = (await client.query(`INSERT INTO playlist_memberships (id, group_playlist_id, user_id, status)
        VALUES ($1, $2, $3, 'invited') ON CONFLICT (group_playlist_id, user_id)
        DO UPDATE SET user_id = EXCLUDED.user_id RETURNING id, status`, [randomUUID(), invite.group_playlist_id, userId])).rows[0]!;
      if (member.status === 'removed') throw new IngestionError(409, 'membership_removed');
      await client.query('INSERT INTO invite_acceptances (invite_id, user_id) VALUES ($1, $2) ON CONFLICT DO NOTHING', [invite.id, userId]);
      return { groupId: invite.group_playlist_id as string, membershipId: member.id as string, status: member.status as string };
    });
  }
}
