import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { IngestionError } from '../domain/errors.js';
import type { ConnectionAuthorizer, OAuthProvider } from '../providers/AuthorizationProvider.js';
import { TokenVault } from './TokenVault.js';
import { digest, secret, transaction } from './onboardingSupport.js';

export class ConnectionService {
  constructor(private readonly pool: Pool, private readonly vault: TokenVault,
    private readonly authorizer: ConnectionAuthorizer, private readonly returnTargets: ReadonlySet<string>) {}

  async begin(userId: string, provider: OAuthProvider, returnTo: string) {
    if (!this.returnTargets.has(returnTo)) throw new IngestionError(400, 'invalid_return_target');
    const state = secret();
    const verifier = secret();
    const authorizationUrl = this.authorizer.begin(provider, state, verifier);
    const stateHash = digest(state);
    await this.pool.query(`INSERT INTO connection_authorizations
      (state_hash, user_id, provider, encrypted_verifier, return_to, expires_at)
      VALUES ($1, $2, $3, $4, $5, now() + interval '10 minutes')`,
    [stateHash, userId, provider, this.vault.encrypt(verifier, stateHash), returnTo]);
    return { authorizationUrl, expiresIn: 600 };
  }

  async complete(provider: OAuthProvider, state: string, code: string | undefined) {
    const stateHash = digest(state);
    const row = (await this.pool.query(`UPDATE connection_authorizations SET consumed_at = now()
      WHERE state_hash = $1 AND provider = $2 AND consumed_at IS NULL AND expires_at > now()
      RETURNING user_id, encrypted_verifier, return_to`, [stateHash, provider])).rows[0];
    if (!row) throw new IngestionError(400, 'invalid_oauth_state');
    if (!code) throw new IngestionError(400, 'provider_authorization_denied');
    const tokens = await this.authorizer.exchange(provider, code, this.vault.decrypt(row.encrypted_verifier as string, stateHash));
    const connection = await this.store(row.user_id as string, provider, tokens.accessToken, tokens.refreshToken,
      tokens.expiresIn, tokens.storefront, tokens.accountId);
    return { ...connection, returnTo: row.return_to as string };
  }

  async registerApple(userId: string, token: string) {
    const storefront = await this.authorizer.apple(token);
    return this.store(userId, 'apple_music', token, null, null, storefront, null);
  }

  private async store(userId: string, provider: string, accessToken: string, refreshToken: string | null,
    expiresIn: number | null, storefront: string, accountId: string | null) {
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`connect:${userId}:${provider}`]);
      const existing = (await client.query('SELECT id, provider_account_id FROM streaming_connections WHERE user_id = $1 AND provider = $2', [userId, provider])).rows[0];
      const connectionId = existing?.id as string | undefined ?? randomUUID();
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`fanout-connection:${connectionId}`]);
      if (existing?.provider_account_id && existing.provider_account_id !== accountId) throw new IngestionError(409, 'provider_account_change_requires_reconcile');
      await client.query(`INSERT INTO streaming_connections (id, user_id, provider, encrypted_access_token,
        encrypted_refresh_token, token_expires_at, storefront, status, provider_account_id)
        VALUES ($1, $2, $3, $4, $5, CASE WHEN $6::integer IS NULL THEN NULL ELSE now() + $6 * interval '1 second' END, $7, 'active', $8)
        ON CONFLICT (user_id, provider) DO UPDATE SET encrypted_access_token = EXCLUDED.encrypted_access_token,
          encrypted_refresh_token = EXCLUDED.encrypted_refresh_token, token_expires_at = EXCLUDED.token_expires_at,
          storefront = EXCLUDED.storefront, status = 'active', provider_account_id = EXCLUDED.provider_account_id`,
      [connectionId, userId, provider, this.vault.encrypt(accessToken, connectionId),
        refreshToken ? this.vault.encrypt(refreshToken, connectionId) : null, expiresIn, storefront, accountId]);
      return { connectionId, provider, storefront, status: 'active' };
    });
  }

  async list(userId: string) {
    return (await this.pool.query(`SELECT id, provider, storefront, status, token_expires_at AS "tokenExpiresAt"
      FROM streaming_connections WHERE user_id = $1 ORDER BY provider`, [userId])).rows;
  }

  async revoke(userId: string, connectionId: string) {
    return transaction(this.pool, async client => {
      await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1, 0))', [`fanout-connection:${connectionId}`]);
      const result = await client.query(`UPDATE streaming_connections SET status = 'revoked', encrypted_access_token = '',
        encrypted_refresh_token = NULL, token_expires_at = NULL WHERE id = $1 AND user_id = $2`, [connectionId, userId]);
      if (!result.rowCount) throw new IngestionError(404, 'connection_not_found');
      await client.query(`UPDATE playlist_memberships SET status = 'paused'
        WHERE streaming_connection_id = $1 AND status IN ('active', 'provisioning', 'recreating')`, [connectionId]);
      return { revoked: true };
    });
  }
}
