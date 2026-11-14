import type { Pool } from 'pg';
import type { SessionConfig } from '../api/auth.js';
import type { JobQueue } from '../jobs/queue.js';
import { appleDeveloperToken } from '../providers/AppleMusicAdapter.js';
import { AppleSignInVerifier, ProviderAuthorization, type AuthorizationConfig, type OAuthProvider } from '../providers/AuthorizationProvider.js';
import { ProviderHttp } from '../providers/http.js';
import type { ProviderRegistry } from '../providers/StreamingProviderAdapter.js';
import { ConnectionService } from './ConnectionService.js';
import { GroupService } from './GroupService.js';
import { ProvisioningService } from './ProvisioningService.js';
import { SessionService } from './SessionService.js';
import type { TokenVault } from './TokenVault.js';

function https(value: string): string {
  const url = new URL(value);
  if (url.protocol !== 'https:' || url.username || url.password || url.hash) throw new Error('Authorization URLs must use HTTPS without credentials or fragments');
  return value;
}

export function configureOnboarding(pool: Pool, queue: JobQueue, session: SessionConfig | undefined,
  providers: { registry: ProviderRegistry; vault: TokenVault } | undefined, env: NodeJS.ProcessEnv = process.env) {
  if (!session || !providers) return undefined;
  const http = new ProviderHttp();
  const configs: Partial<Record<OAuthProvider, AuthorizationConfig>> = {};
  for (const [provider, prefix] of [['spotify', 'SPOTIFY'], ['youtube_music', 'GOOGLE']] as const) {
    const redirectUri = env[`${prefix}_REDIRECT_URI`];
    if (redirectUri) {
      const clientId = env[`${prefix}_CLIENT_ID`];
      const clientSecret = env[`${prefix}_CLIENT_SECRET`];
      if (!clientId || !clientSecret) throw new Error(`${prefix} authorization requires client ID and secret`);
      configs[provider] = { clientId, clientSecret, redirectUri: https(redirectUri) };
    }
  }
  const { APPLE_SIGNIN_CLIENT_ID: clientId, APPLE_SIGNIN_TEAM_ID: teamId, APPLE_SIGNIN_KEY_ID: keyId, APPLE_SIGNIN_PRIVATE_KEY: privateKey } = env;
  if ([clientId, teamId, keyId, privateKey].some(Boolean) && ![clientId, teamId, keyId, privateKey].every(Boolean)) throw new Error('Apple sign-in requires client, team, key ID, and private key');
  const apple = clientId && teamId && keyId && privateKey ? new AppleSignInVerifier(http, { clientId, teamId, keyId, privateKey,
    ...(env.APPLE_SIGNIN_REDIRECT_URI ? { redirectUri: https(env.APPLE_SIGNIN_REDIRECT_URI) } : {}) }) : undefined;
  let developerToken: (() => Promise<string>) | undefined;
  if (env.APPLE_TEAM_ID && env.APPLE_KEY_ID && env.APPLE_PRIVATE_KEY) developerToken = appleDeveloperToken({
    teamId: env.APPLE_TEAM_ID, keyId: env.APPLE_KEY_ID, privateKey: env.APPLE_PRIVATE_KEY,
  });
  else if (env.APPLE_MUSIC_DEVELOPER_TOKEN) { const token = env.APPLE_MUSIC_DEVELOPER_TOKEN; developerToken = async () => token; }
  const returns = new Set((env.OAUTH_RETURN_TARGETS ?? '').split(',').map(value => value.trim()).filter(Boolean));
  for (const target of returns) https(target);
  return {
    sessions: new SessionService(pool, session, apple),
    connections: new ConnectionService(pool, providers.vault, new ProviderAuthorization(http, configs, developerToken), returns),
    groups: new GroupService(pool, providers.vault),
    provisioning: new ProvisioningService(pool, queue, providers.registry, providers.vault),
  };
}
