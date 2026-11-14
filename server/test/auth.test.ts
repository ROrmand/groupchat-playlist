import assert from 'node:assert/strict';
import { test } from 'node:test';
import { SignJWT } from 'jose';
import { createSessionVerifier, IngestionRateLimiter } from '../src/api/auth.js';

const config = { secret: 'test-only-secret-with-at-least-32-bytes', issuer: 'baton', audience: 'baton-api' };
const userId = '00000000-0000-0000-0000-000000000001';

async function token(options: { audience?: string; expiration?: string | number; subject?: string; algorithm?: string } = {}): Promise<string> {
  return new SignJWT({}).setProtectedHeader({ alg: options.algorithm ?? 'HS256' }).setIssuer(config.issuer)
    .setAudience(options.audience ?? config.audience).setSubject(options.subject ?? userId).setIssuedAt()
    .setExpirationTime(options.expiration ?? '15m').sign(new TextEncoder().encode(config.secret));
}

test('signed sessions validate algorithm, expiry, issuer/audience and UUID subject', async () => {
  const verify = createSessionVerifier(config);
  assert.equal(await verify(`Bearer ${await token()}`), userId);
  for (const value of [undefined, 'Bearer nope', `Bearer ${await token({ audience: 'other' })}`,
    `Bearer ${await token({ expiration: 1 })}`, `Bearer ${await token({ subject: 'untrusted-user' })}`,
    `Bearer ${await token({ algorithm: 'HS384' })}`, `Bearer ${await token()}tampered`]) {
    await assert.rejects(verify(value), { status: 401, code: 'invalid_session' });
  }
  const missingExpiry = await new SignJWT({ sub: userId }).setProtectedHeader({ alg: 'HS256' })
    .setIssuer(config.issuer).setAudience(config.audience).sign(new TextEncoder().encode(config.secret));
  await assert.rejects(verify(`Bearer ${missingExpiry}`), { code: 'invalid_session' });
  await assert.rejects(createSessionVerifier(undefined)(undefined), { status: 503 });
  assert.throws(() => createSessionVerifier({ ...config, secret: 'short' }), /32 bytes/);
});

test('per-user rate limiting resets and bounds stored identities', () => {
  let now = 1000;
  const limiter = new IngestionRateLimiter(2, () => now);
  limiter.check(userId);
  limiter.check(userId);
  assert.throws(() => limiter.check(userId), { status: 429 });
  now += 60000;
  limiter.check(userId);
  for (let index = 0; index < 9999; index += 1) limiter.check(`user-${index}`);
  assert.throws(() => limiter.check('overflow'), { status: 429 });
  now += 60000;
  limiter.check('overflow');
});
