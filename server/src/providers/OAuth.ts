import { ProviderHttp, identifier, jsonRequest } from './http.js';
import { ProviderSyncError, type StreamingConnection, type TokenRefreshResult } from './StreamingProviderAdapter.js';

export interface OAuthCredentials { clientId: string; clientSecret: string }

export async function refreshOAuth(http: ProviderHttp, provider: 'spotify' | 'youtube_music', connection: StreamingConnection,
  credentials: OAuthCredentials | undefined): Promise<TokenRefreshResult> {
  if (!credentials) throw new ProviderSyncError('NOT_CONFIGURED');
  if (!connection.refreshToken) throw new ProviderSyncError('TOKEN_EXPIRED');
  const body = new URLSearchParams({ grant_type: 'refresh_token', refresh_token: connection.refreshToken });
  const headers: Record<string, string> = { 'content-type': 'application/x-www-form-urlencoded' };
  if (provider === 'spotify') headers.authorization = `Basic ${Buffer.from(`${credentials.clientId}:${credentials.clientSecret}`).toString('base64')}`;
  else { body.set('client_id', credentials.clientId); body.set('client_secret', credentials.clientSecret); }
  try {
    const result = await http.request(provider === 'spotify' ? 'https://accounts.spotify.com/api/token' : 'https://oauth2.googleapis.com/token',
      { method: 'POST', headers, body: body.toString() });
    const expiresIn = result.expires_in;
    if (typeof expiresIn !== 'number' || !Number.isSafeInteger(expiresIn) || expiresIn < 1) throw new ProviderSyncError('INVALID_RESPONSE');
    return { accessToken: identifier(result.access_token), refreshToken: result.refresh_token === undefined
      ? connection.refreshToken : identifier(result.refresh_token), expiresIn };
  } catch (error) {
    if (error instanceof ProviderSyncError && error.code === 'INVALID_RESPONSE') throw new ProviderSyncError('TOKEN_EXPIRED');
    throw error;
  }
}

export function validateBatch(trackIds: string[], limit: number): void {
  if (!trackIds.length || trackIds.length > limit || trackIds.some(trackId => !trackId)) throw new ProviderSyncError('INVALID_RESPONSE');
}

export { jsonRequest };
