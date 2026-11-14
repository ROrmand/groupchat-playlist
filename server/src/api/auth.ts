import { jwtVerify } from 'jose';
import { IngestionError } from '../domain/errors.js';

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export interface SessionConfig {
  secret: string;
  issuer: string;
  audience: string;
}

export function createSessionVerifier(config: SessionConfig | undefined): (authorization: string | undefined) => Promise<string> {
  if (config && Buffer.byteLength(config.secret) < 32) throw new Error('SESSION_JWT_SECRET must contain at least 32 bytes');
  return async authorization => {
    if (!config) throw new IngestionError(503, 'session_verification_not_configured');
    const match = /^Bearer ([A-Za-z0-9_-]+\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+)$/.exec(authorization ?? '');
    if (!match || match[1]!.length > 4096) throw new IngestionError(401, 'invalid_session');
    try {
      const { payload } = await jwtVerify(match[1]!, new TextEncoder().encode(config.secret), {
        algorithms: ['HS256'], issuer: config.issuer, audience: config.audience,
        requiredClaims: ['sub', 'iat', 'exp'], maxTokenAge: '1h',
      });
      if (!payload.sub || !uuidPattern.test(payload.sub)) throw new Error('Invalid subject');
      return payload.sub.toLowerCase();
    } catch { throw new IngestionError(401, 'invalid_session'); }
  };
}

export class IngestionRateLimiter {
  private readonly users = new Map<string, { count: number; expiresAt: number }>();

  constructor(private readonly limit = 60, private readonly now: () => number = Date.now) {}

  check(userId: string): void {
    const now = this.now();
    let record = this.users.get(userId);
    if (!record || record.expiresAt <= now) {
      if (this.users.size >= 10000) {
        for (const [key, value] of this.users) if (value.expiresAt <= now) this.users.delete(key);
        if (!this.users.has(userId) && this.users.size >= 10000) throw new IngestionError(429, 'rate_limited');
      }
      record = { count: 0, expiresAt: now + 60000 };
      this.users.set(userId, record);
    }
    if (record.count >= this.limit) throw new IngestionError(429, 'rate_limited');
    record.count += 1;
  }
}
