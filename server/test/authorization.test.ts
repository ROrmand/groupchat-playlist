import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { test } from 'node:test';
import { exportJWK, exportPKCS8, generateKeyPair, SignJWT } from 'jose';
import { AppleSignInVerifier, ProviderAuthorization } from '../src/providers/AuthorizationProvider.js';
import { ProviderHttp } from '../src/providers/http.js';
import { TokenVault } from '../src/services/TokenVault.js';
import { loadConfig } from '../src/config.js';

test('Apple code exchange verifies signed identity, issuer, audience, expiry, nonce and key selection offline', async () => {
  const signing = await generateKeyPair('ES256', { extractable: true });
  const apple = await generateKeyPair('RS256');
  const unknown = await generateKeyPair('RS256');
  const jwk = { ...await exportJWK(apple.publicKey), kid: 'apple-key', alg: 'RS256' };
  const config = { clientId: 'app.baton', teamId: 'team', keyId: 'key', privateKey: await exportPKCS8(signing.privateKey) };
  let token = '';
  let rejectCode = false;
  let keyReads = 0;
  const verifier = new AppleSignInVerifier(new ProviderHttp(async (url, init) => {
    if (url.endsWith('/auth/keys')) { keyReads += 1; return Response.json({ keys: [jwk] }); }
    assert.equal(url, 'https://appleid.apple.com/auth/token');
    assert.equal(init.redirect, 'error');
    const body = new URLSearchParams(String(init.body));
    assert.equal(body.get('grant_type'), 'authorization_code');
    assert.equal(body.get('client_id'), config.clientId);
    assert.equal(body.get('code'), 'code');
    assert.ok(body.get('client_secret'));
    return rejectCode ? Response.json({ error: 'invalid_grant' }, { status: 400 }) : Response.json({ id_token: token });
  }), config);
  const issue = (overrides: Record<string, unknown> = {}, key = apple.privateKey, kid = 'apple-key') =>
    new SignJWT({ nonce: 'expected', ...overrides }).setProtectedHeader({ alg: 'RS256', kid }).setSubject('stable-apple-sub')
      .setIssuedAt().setExpirationTime('5m').setIssuer('https://appleid.apple.com').setAudience(config.clientId).sign(key);
  token = await issue();
  assert.equal(await verifier.verify('code', 'expected'), 'stable-apple-sub');
  assert.equal(keyReads, 1);
  for (const invalid of [await issue({ nonce: 'wrong' }), await issue({}, unknown.privateKey), await issue({}, apple.privateKey, 'missing'),
    await new SignJWT({ nonce: 'expected' }).setProtectedHeader({ alg: 'RS256', kid: 'apple-key' }).setSubject('subject')
      .setIssuedAt().setExpirationTime('5m').setIssuer('wrong').setAudience(config.clientId).sign(apple.privateKey),
    await new SignJWT({ nonce: 'expected' }).setProtectedHeader({ alg: 'RS256', kid: 'apple-key' }).setSubject('subject')
      .setIssuedAt().setExpirationTime('5m').setIssuer('https://appleid.apple.com').setAudience('wrong').sign(apple.privateKey),
    await new SignJWT({ nonce: 'expected' }).setProtectedHeader({ alg: 'RS256', kid: 'apple-key' }).setSubject('subject')
      .setIssuedAt().setExpirationTime(1).setIssuer('https://appleid.apple.com').setAudience(config.clientId).sign(apple.privateKey),
    await new SignJWT({}).setProtectedHeader({ alg: 'RS256', kid: 'apple-key' }).setSubject('subject')
      .setIssuedAt().setExpirationTime('5m').setIssuer('https://appleid.apple.com').setAudience(config.clientId).sign(apple.privateKey)]) {
    token = invalid;
    await assert.rejects(verifier.verify('code', 'expected'), { code: 'invalid_apple_authorization' });
  }
  rejectCode = true;
  await assert.rejects(verifier.verify('code', 'expected'), { code: 'invalid_apple_authorization' });
});

test('provider authorization sends S256 PKCE, validates scopes and profiles, and validates Apple Music storefront', async () => {
  const config = { clientId: 'client', clientSecret: 'secret', redirectUri: 'https://baton.example/callback' };
  let scopes = 'user-read-private playlist-read-private playlist-modify-private';
  let provider: 'spotify' | 'youtube_music' = 'spotify';
  const auth = new ProviderAuthorization(new ProviderHttp(async (url, init) => {
    if (url.endsWith('/api/token') || url.endsWith('/token')) {
      const body = new URLSearchParams(String(init.body));
      assert.equal(body.get('code_verifier'), 'verifier');
      assert.equal(body.get('redirect_uri'), config.redirectUri);
      assert.equal(body.get('code'), 'authorization-code');
      assert.equal(body.get('grant_type'), 'authorization_code');
      return Response.json({ access_token: 'access-secret', refresh_token: 'refresh-secret', expires_in: 3600, scope: scopes });
    }
    if (url.endsWith('/me/storefront')) {
      assert.equal((init.headers as Record<string, string>)['music-user-token'], 'music-secret');
      return Response.json({ data: [{ id: 'gb' }] });
    }
    return Response.json(provider === 'spotify' ? { id: 'spotify-account', country: 'GB' } : { items: [{ id: 'channel' }] });
  }), { spotify: config, youtube_music: config }, async () => 'developer');
  for (const name of ['spotify', 'youtube_music'] as const) {
    const url = new URL(auth.begin(name, 'state-secret', 'verifier'));
    assert.equal(url.searchParams.get('code_challenge_method'), 'S256');
    assert.equal(url.searchParams.get('code_challenge'), createHash('sha256').update('verifier').digest('base64url'));
    assert.equal(url.searchParams.get('state'), 'state-secret');
  }
  assert.deepEqual(await auth.exchange('spotify', 'authorization-code', 'verifier'), {
    accessToken: 'access-secret', refreshToken: 'refresh-secret', expiresIn: 3600, storefront: 'gb', accountId: 'spotify-account',
  });
  scopes = '';
  await assert.rejects(auth.exchange('spotify', 'authorization-code', 'verifier'), { code: 'insufficient_provider_scopes' });
  provider = 'youtube_music';
  scopes = 'https://www.googleapis.com/auth/youtube.force-ssl';
  assert.equal((await auth.exchange(provider, 'authorization-code', 'verifier')).accountId, 'channel');
  assert.equal(await auth.apple('music-secret'), 'gb');
  await assert.rejects(new ProviderAuthorization(new ProviderHttp(), {}).apple('token'), { status: 503 });
  assert.throws(() => new ProviderAuthorization(new ProviderHttp(), {}).begin('spotify', 'state', 'verifier'), { status: 503 });
});

test('invite derivation is stable, domain-separated, key-bound and never exposes the vault key', () => {
  const vault = new TokenVault(Buffer.alloc(32, 4).toString('base64'));
  assert.equal(vault.deriveInviteToken('id'), vault.deriveInviteToken('id'));
  assert.notEqual(vault.deriveInviteToken('id'), vault.deriveInviteToken('other-id'));
  assert.notEqual(vault.deriveInviteToken('id'), new TokenVault(Buffer.alloc(32, 5).toString('base64')).deriveInviteToken('id'));
  assert.match(vault.deriveInviteToken('id'), /^[A-Za-z0-9_-]{43}$/);
});

test('legacy development authentication cannot be enabled in production', () => {
  assert.throws(() => loadConfig({ DATABASE_URL: 'postgres://localhost/baton', NODE_ENV: 'production', ALLOW_DEV_SESSIONS: '1' }), /cannot be enabled/);
});
