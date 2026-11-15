import { refreshGrant } from '../../../services/oauth/client.js';
import { isOAuthProviderId } from '../../../services/oauth/providers.js';
import { accessTokenStale, oauthSecretFromGrant } from '../../../services/oauth/secret.js';
import type { OAuthProviderId } from '../../../sync/providers/oauthEndpoints.js';
import type { AuthMethod, Provider } from '../../../types/domain.js';
import { AuthStrategy, type HeaderBuilder, type SecretJson } from './AuthStrategy.js';

/**
 * How an OAuth access token is kept fresh:
 * - `stored`: the sealed secret holds an expiring access token and its refresh token, refreshed
 *   (and sealed again) when it is close to its expiry (GitHub, Jira, ClickUp, Linear);
 * - `per_call`: the sealed secret holds the refresh token only, and every call trades it for an
 *   access token kept in memory for that call (Google Calendar).
 */
export type RefreshPolicy = 'stored' | 'per_call';

export interface OAuthAuthOptions<TSecret extends SecretJson> {
  provider: Provider;
  refresh: RefreshPolicy;
  headers: HeaderBuilder<TSecret>;
}

/** The bearer header of a stored access token (the refresher's own headers, never used to call). */
const bearer: HeaderBuilder<SecretJson> = (secret) => ({
  authorization: `Bearer ${secret['accessToken'] ?? ''}`,
});

/**
 * Connected through the provider's OAuth sign-in (the app's flow in services/oauth and
 * googleCalendarOAuth.ts): the user's own grant, sealed as `{accessToken, refreshToken?,
 * accessTokenExpiresAt?, scope}` (or Google's `{refreshToken, scope}`). Its credential arrives
 * only through the OAuth callback; a credential PUT for it is refused like any shape that doesn't
 * fit.
 */
export class OAuthAuth<TSecret extends SecretJson = SecretJson> extends AuthStrategy<TSecret> {
  readonly kind = 'oauth';
  readonly methods: readonly [AuthMethod, ...AuthMethod[]] = ['oauth'];
  readonly provider: Provider;
  readonly refreshPolicy: RefreshPolicy;

  constructor(options: OAuthAuthOptions<TSecret>) {
    super(options.headers);
    this.provider = options.provider;
    this.refreshPolicy = options.refresh;
  }

  /**
   * The refresher of a provider whose sealed secret holds an expiring access token: what the
   * credential uses to keep it fresh, whichever integration of that provider it belongs to.
   */
  static storedToken(provider: OAuthProviderId): OAuthAuth {
    return new OAuthAuth({ provider, refresh: 'stored', headers: bearer });
  }

  /** A stored access token close to its expiry (ACCESS_TOKEN_SKEW_MS) is refreshed first. */
  needsRefresh(secret: SecretJson, now: Date): boolean {
    return this.refreshPolicy === 'stored' && accessTokenStale(secret, now);
  }

  /**
   * The next secret: the refresh token traded for a new grant at the provider, the old refresh
   * token kept when the provider did not rotate it. A refused refresh is `auth_failed`.
   */
  async refresh(secret: SecretJson): Promise<Record<string, string>> {
    const provider: string = this.provider;
    if (this.refreshPolicy !== 'stored' || !isOAuthProviderId(provider)) {
      throw new Error(`${this.provider} does not refresh a stored access token`);
    }
    const grant = await refreshGrant(provider, secret['refreshToken'] ?? '');
    return oauthSecretFromGrant(grant, secret['refreshToken'] ?? null, new Date());
  }
}
