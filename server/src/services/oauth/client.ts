/**
 * The token client of each OAuth provider: its app credentials (the app secret `oauth-<provider>`,
 * services/appSecrets.ts), the allow-listed token and revoke URLs (sync/http.ts), and the refresh
 * grant. The id and secret are never logged, returned or put in an error.
 */
import {
  createReadOnlyClient,
  ProviderHttpError,
  type ReadOnlyClient,
  type TokenGrant,
  type Transport,
} from '../../sync/http.js';
import { oauthEndpoints, type OAuthProviderId } from '../../sync/providers/oauthEndpoints.js';
import { AppSecretError, getAppSecret } from '../appSecrets.js';
import { LINEAR_VIEWER_DOCUMENT, OAUTH_PROVIDER_DEFS } from './providers.js';
import { oauthTransport } from './transport.js';

export interface OAuthAppCredentials {
  clientId: string;
  clientSecret: string;
  /** GitHub only (optional in the secret): the app's slug, for its install link. */
  appSlug?: string;
}

/**
 * The OAuth app's id and secret, or null when this server has none configured. Any other failure
 * throws a generic error (appSecrets.ts has logged its kind, never the value).
 */
export async function oauthAppCredentials(
  provider: OAuthProviderId,
): Promise<OAuthAppCredentials | null> {
  try {
    const json = await getAppSecret<Record<string, unknown>>(
      OAUTH_PROVIDER_DEFS[provider].secretName,
    );
    const { clientId, clientSecret, appSlug } = json;
    if (typeof clientId !== 'string' || typeof clientSecret !== 'string') return null;
    return {
      clientId,
      clientSecret,
      ...(typeof appSlug === 'string' && /^[A-Za-z0-9-]{1,100}$/.test(appSlug) ? { appSlug } : {}),
    };
  } catch (error) {
    if (error instanceof AppSecretError && error.reason === 'missing') return null;
    throw new Error(`The ${provider} OAuth secret could not be read`);
  }
}

/** A client for the provider's token, revoke and identity calls. */
export function oauthClient(
  provider: OAuthProviderId,
  transport: Transport = oauthTransport(),
): ReadOnlyClient {
  const endpoints = oauthEndpoints(provider);
  return createReadOnlyClient({
    provider,
    transport,
    tokenExchangeUrl: endpoints.token,
    ...(endpoints.revoke === null ? {} : { revokeUrl: endpoints.revoke }),
    ...(provider === 'linear'
      ? {
          graphql: {
            endpoint: `${endpoints.api}/graphql`,
            documents: { Viewer: LINEAR_VIEWER_DOCUMENT },
          },
        }
      : {}),
  });
}

/**
 * Trades a refresh token for a new grant. A refused one (revoked, expired, already rotated away)
 * is `auth_failed`; a server without the app secret is a plain error (fixing the server fixes it).
 */
export async function refreshGrant(
  provider: OAuthProviderId,
  refreshToken: string,
): Promise<TokenGrant> {
  const credentials = await oauthAppCredentials(provider);
  if (credentials === null) throw new Error(`${provider} sign-in is not set up on this server`);
  if (refreshToken === '') throw new ProviderHttpError(provider, null, 'auth_failed');
  return oauthClient(provider).exchangeToken(
    {
      grant_type: 'refresh_token',
      refresh_token: refreshToken,
      client_id: credentials.clientId,
      client_secret: credentials.clientSecret,
    },
    { format: OAUTH_PROVIDER_DEFS[provider].tokenFormat },
  );
}
