import { randomUUID } from 'node:crypto';
import { SignJWT, jwtVerify } from 'jose';
import type { Pool, PoolClient } from 'pg';
import { type SessionConfig, uuidPattern } from '../api/auth.js';
import { IngestionError } from '../domain/errors.js';
import { digest, secret, transaction } from './onboardingSupport.js';

export interface AppleIdentityVerifier { verify(code: string, nonce: string): Promise<string> }

export class SessionService {
  constructor(private readonly pool: Pool, private readonly config: SessionConfig,
    private readonly apple: AppleIdentityVerifier | undefined) {}

  async challenge() {
    if (!this.apple) throw new IngestionError(503, 'apple_signin_not_configured');
    const challenge = secret();
    const nonce = secret();
    await this.pool.query(`INSERT INTO auth_challenges VALUES ($1, $2, now() + interval '5 minutes', NULL)`, [digest(challenge), nonce]);
    return { challenge, nonce, expiresIn: 300 };
  }

  async signIn(code: string, challenge: string) {
    if (!this.apple) throw new IngestionError(503, 'apple_signin_not_configured');
    const row = (await this.pool.query(`UPDATE auth_challenges SET consumed_at = now()
      WHERE secret_hash = $1 AND consumed_at IS NULL AND expires_at > now() RETURNING nonce`, [digest(challenge)])).rows[0];
    if (!row) throw new IngestionError(401, 'invalid_challenge');
    const subject = await this.apple.verify(code, row.nonce as string);
    return transaction(this.pool, async client => {
      const user = (await client.query(`INSERT INTO users (id, apple_sub, display_name) VALUES ($1, $2, '')
        ON CONFLICT (apple_sub) DO UPDATE SET apple_sub = EXCLUDED.apple_sub RETURNING id`, [randomUUID(), subject])).rows[0]!;
      const sessionId = randomUUID();
      await client.query(`INSERT INTO auth_sessions (id, user_id, expires_at) VALUES ($1, $2, now() + interval '30 days')`, [sessionId, user.id]);
      return this.issue(client, user.id as string, sessionId);
    });
  }

  async refresh(token: string) {
    const result = await transaction(this.pool, async client => {
      const found = (await client.query('SELECT session_id FROM session_refresh_tokens WHERE token_hash = $1', [digest(token)])).rows[0];
      if (!found) return undefined;
      const row = (await client.query('SELECT * FROM auth_sessions WHERE id = $1 FOR UPDATE', [found.session_id])).rows[0];
      if (!row || row.revoked_at || new Date(row.expires_at as string).getTime() <= Date.now()) return undefined;
      const refresh = (await client.query('SELECT used_at FROM session_refresh_tokens WHERE token_hash = $1', [digest(token)])).rows[0]!;
      if (refresh.used_at) {
        await client.query('UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [row.id]);
        return undefined;
      }
      await client.query('UPDATE session_refresh_tokens SET used_at = now() WHERE token_hash = $1', [digest(token)]);
      return this.issue(client, row.user_id as string, row.id as string);
    });
    if (!result) throw new IngestionError(401, 'invalid_refresh_token');
    return result;
  }

  private async claims(authorization: string | undefined) {
    try {
      const match = /^Bearer ([A-Za-z0-9_.-]{1,4096})$/.exec(authorization ?? '');
      if (!match) throw new Error();
      const { payload } = await jwtVerify(match[1]!, new TextEncoder().encode(this.config.secret), {
        algorithms: ['HS256'], issuer: this.config.issuer, audience: this.config.audience,
        requiredClaims: ['sub', 'sid', 'iat', 'exp'], maxTokenAge: '15m',
      });
      if (!payload.sub || !uuidPattern.test(payload.sub) || typeof payload.sid !== 'string' || !uuidPattern.test(payload.sid)) throw new Error();
      const session = await this.pool.query(`SELECT id FROM auth_sessions WHERE id = $1 AND user_id = $2
        AND revoked_at IS NULL AND expires_at > now()`, [payload.sid, payload.sub]);
      if (!session.rowCount) throw new Error();
      return { userId: payload.sub, sessionId: payload.sid };
    } catch { throw new IngestionError(401, 'invalid_session'); }
  }

  async authenticate(authorization: string | undefined): Promise<string> { return (await this.claims(authorization)).userId; }

  async logout(authorization: string | undefined, all: boolean) {
    const { userId, sessionId } = await this.claims(authorization);
    await this.pool.query(all ? 'UPDATE auth_sessions SET revoked_at = now() WHERE user_id = $1'
      : 'UPDATE auth_sessions SET revoked_at = now() WHERE id = $1', [all ? userId : sessionId]);
    return { revoked: true };
  }

  private async issue(client: PoolClient, userId: string, sessionId: string) {
    const refreshToken = secret();
    await client.query('INSERT INTO session_refresh_tokens (token_hash, session_id) VALUES ($1, $2)', [digest(refreshToken), sessionId]);
    const accessToken = await new SignJWT({ sid: sessionId }).setProtectedHeader({ alg: 'HS256' }).setSubject(userId)
      .setIssuer(this.config.issuer).setAudience(this.config.audience).setIssuedAt().setExpirationTime('15m')
      .sign(new TextEncoder().encode(this.config.secret));
    return { userId, accessToken, refreshToken, expiresIn: 900 };
  }
}
