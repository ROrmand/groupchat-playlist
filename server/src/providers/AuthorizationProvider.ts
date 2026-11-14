import { createHash } from 'node:crypto';
import { createLocalJWKSet, importPKCS8, jwtVerify, SignJWT, type JSONWebKeySet } from 'jose';
import { IngestionError } from '../domain/errors.js';
import { ProviderHttp, identifier, jsonRequest, rows } from './http.js';
import type { AppleIdentityVerifier } from '../services/SessionService.js';

export type OAuthProvider = 'spotify' | 'youtube_music';
export interface AuthorizationConfig { clientId: string; clientSecret: string; redirectUri: string }
export interface AppleSignInConfig { clientId: string; teamId: string; keyId: string; privateKey: string; redirectUri?: string }
export interface AuthorizedConnection { accessToken: string; refreshToken: string; expiresIn: number; storefront: string; accountId: string }

export interface ConnectionAuthorizer {
  begin(provider: OAuthProvider, state: string, verifier: string): string;
  exchange(provider: OAuthProvider, code: string, verifier: string): Promise<AuthorizedConnection>;
  apple(token: string): Promise<string>;
}

export class AppleSignInVerifier implements AppleIdentityVerifier {
  private keys: { resolver: ReturnType<typeof createLocalJWKSet>; until: number } | undefined;

  constructor(private readonly http: ProviderHttp, private readonly config: AppleSignInConfig) {}

  async verify(code: string, nonce: string): Promise<string> {
    try {
      const key = await importPKCS8(this.config.privateKey.replaceAll('\\n', '\n'), 'ES256');
      const clientSecret = await new SignJWT({}).setProtectedHeader({ alg: 'ES256', kid: this.config.keyId })
        .setIssuer(this.config.teamId).setAudience('https://appleid.apple.com').setSubject(this.config.clientId)
        .setIssuedAt().setExpirationTime('5m').sign(key);
      const body = new URLSearchParams({ grant_type: 'authorization_code', code, client_id: this.config.clientId, client_secret: clientSecret });
      if (this.config.redirectUri) body.set('redirect_uri', this.config.redirectUri);
      const tokens = await this.http.request('https://appleid.apple.com/auth/token', {
        method: 'POST', headers: { 'content-type': 'application/x-www-form-urlencoded' }, body: body.toString(),
      });
      const idToken = identifier(tokens.id_token);
      if (!this.keys || this.keys.until < Date.now()) {
        const jwks = await this.http.request('https://appleid.apple.com/auth/keys', { method: 'GET' });
        this.keys = { resolver: createLocalJWKSet(jwks as unknown as JSONWebKeySet), until: Date.now() + 300000 };
      }
      const { payload } = await jwtVerify(idToken, this.keys.resolver, {
        algorithms: ['RS256'], issuer: 'https://appleid.apple.com', audience: this.config.clientId,
        requiredClaims: ['sub', 'iat', 'exp', 'nonce'], maxTokenAge: '10m',
      });
      if (!payload.sub || payload.nonce !== nonce) throw new Error();
      return payload.sub;
    } catch { throw new IngestionError(401, 'invalid_apple_authorization'); }
  }
}

export class ProviderAuthorization implements ConnectionAuthorizer {
  constructor(private readonly http: ProviderHttp, private readonly configs: Partial<Record<OAuthProvider, AuthorizationConfig>>,
    private readonly developerToken?: () => Promise<string>) {}

  private config(provider: OAuthProvider): AuthorizationConfig {
    const config = this.configs[provider];
    if (!config) throw new IngestionError(503, 'provider_not_configured');
    return config;
  }

  begin(provider: OAuthProvider, state: string, verifier: string): string {
    const config = this.config(provider);
    const query = new URLSearchParams({ response_type: 'code', client_id: config.clientId, redirect_uri: config.redirectUri,
      state, code_challenge_method: 'S256', code_challenge: createHash('sha256').update(verifier).digest('base64url'),
      scope: provider === 'spotify' ? 'user-read-private playlist-read-private playlist-modify-private'
        : 'https://www.googleapis.com/auth/youtube.force-ssl',
    });
    if (provider === 'youtube_music') { query.set('access_type', 'offline'); query.set('prompt', 'consent'); }
    return `${provider === 'spotify' ? 'https://accounts.spotify.com/authorize' : 'https://accounts.google.com/o/oauth2/v2/auth'}?${query}`;
  }

  async exchange(provider: OAuthProvider, code: string, verifier: string): Promise<AuthorizedConnection> {
    const config = this.config(provider);
    const body = new URLSearchParams({ grant_type: 'authorization_code', code, code_verifier: verifier,
      client_id: config.clientId, redirect_uri: config.redirectUri });
    const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
    if (provider === 'spotify') headers.authorization = `Basic ${Buffer.from(`${config.clientId}:${config.clientSecret}`).toString('base64')}`;
    else body.set('client_secret', config.clientSecret);
    const result = await this.http.request(provider === 'spotify' ? 'https://accounts.spotify.com/api/token' : 'https://oauth2.googleapis.com/token',
      { method: 'POST', headers, body: body.toString() });
    const accessToken = identifier(result.access_token);
    const refreshToken = identifier(result.refresh_token);
    if (typeof result.expires_in !== 'number' || !Number.isSafeInteger(result.expires_in) || result.expires_in < 1 || result.expires_in > 31536000) {
      throw new IngestionError(422, 'invalid_provider_authorization');
    }
    const required = provider === 'spotify' ? ['user-read-private', 'playlist-read-private', 'playlist-modify-private']
      : ['https://www.googleapis.com/auth/youtube.force-ssl'];
    const scopes = typeof result.scope === 'string' ? result.scope.split(' ') : [];
    if (required.some(scope => !scopes.includes(scope))) throw new IngestionError(422, 'insufficient_provider_scopes');
    const profile = await this.http.request(provider === 'spotify' ? 'https://api.spotify.com/v1/me'
      : 'https://www.googleapis.com/youtube/v3/channels?part=id,snippet&mine=true', jsonRequest('GET', accessToken));
    const accountId = provider === 'spotify' ? identifier(profile.id) : identifier(rows(profile.items)[0]?.id);
    const country = provider === 'spotify' ? profile.country : undefined;
    return { accessToken, refreshToken, expiresIn: result.expires_in, accountId,
      storefront: typeof country === 'string' && /^[A-Z]{2}$/.test(country) ? country.toLowerCase() : 'us' };
  }

  async apple(token: string): Promise<string> {
    if (!this.developerToken) throw new IngestionError(503, 'provider_not_configured');
    const result = await this.http.request('https://api.music.apple.com/v1/me/storefront', {
      method: 'GET', headers: { authorization: `Bearer ${await this.developerToken()}`, 'music-user-token': token },
    });
    const storefront = identifier(rows(result.data)[0]?.id);
    if (!/^[a-z]{2}$/.test(storefront)) throw new IngestionError(422, 'invalid_storefront');
    return storefront;
  }
}
