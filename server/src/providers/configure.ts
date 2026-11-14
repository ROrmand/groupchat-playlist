import { AppleMusicAdapter, appleDeveloperToken } from './AppleMusicAdapter.js';
import { SpotifyAdapter } from './SpotifyAdapter.js';
import { YouTubeMusicAdapter } from './YouTubeMusicAdapter.js';
import { ProviderHttp } from './http.js';
import { ProviderRegistry } from './StreamingProviderAdapter.js';
import { TokenVault } from '../services/TokenVault.js';
import type { OAuthCredentials } from './OAuth.js';

function oauth(env: NodeJS.ProcessEnv, prefix: string): OAuthCredentials | undefined {
  const clientId = env[`${prefix}_CLIENT_ID`];
  const clientSecret = env[`${prefix}_CLIENT_SECRET`];
  if (Boolean(clientId) !== Boolean(clientSecret)) throw new Error(`${prefix} requires both client ID and client secret`);
  return clientId && clientSecret ? { clientId, clientSecret } : undefined;
}

export function configureProviders(env: NodeJS.ProcessEnv = process.env) {
  if (!env.TOKEN_ENCRYPTION_KEY) return undefined;
  const vault = new TokenVault(env.TOKEN_ENCRYPTION_KEY);
  const http = new ProviderHttp();
  const registry = new ProviderRegistry().register(new SpotifyAdapter(http, oauth(env, 'SPOTIFY')))
    .register(new YouTubeMusicAdapter(http, oauth(env, 'GOOGLE')));
  const { APPLE_TEAM_ID: teamId, APPLE_KEY_ID: keyId, APPLE_PRIVATE_KEY: privateKey } = env;
  if ([teamId, keyId, privateKey].some(Boolean) && ![teamId, keyId, privateKey].every(Boolean)) {
    throw new Error('Apple signing requires team ID, key ID, and private key');
  }
  if (teamId && keyId && privateKey) registry.register(new AppleMusicAdapter(http, appleDeveloperToken({ teamId, keyId, privateKey })));
  else if (env.APPLE_MUSIC_DEVELOPER_TOKEN) {
    const token = env.APPLE_MUSIC_DEVELOPER_TOKEN;
    registry.register(new AppleMusicAdapter(http, async () => token));
  }
  return { vault, registry };
}
