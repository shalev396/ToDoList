/**
 * The sealed secret of an OAuth connection (GitHub, Jira, ClickUp, Linear): text values only,
 * like every credential. `{accessToken, refreshToken?, accessTokenExpiresAt?, scope}`:
 * `accessTokenExpiresAt` is an ISO instant, absent for a token that does not expire (ClickUp).
 * Never logged, returned or put in an error.
 */
import type { TokenGrant } from '../../sync/http.js';

/**
 * Refresh this long before the access token's stated expiry: longer than the longest run (15
 * min), so a run that starts on a token never outlives it.
 */
export const ACCESS_TOKEN_SKEW_MS = 20 * 60 * 1000;

export function oauthSecretFromGrant(
  grant: TokenGrant,
  previousRefreshToken: string | null,
  now: Date,
): Record<string, string> {
  const secret: Record<string, string> = {
    accessToken: grant.accessToken,
    scope: grant.scope ?? '',
  };
  // A refresh that returns no new refresh token keeps the old one (a non-rotating app).
  const refreshToken = grant.refreshToken ?? previousRefreshToken;
  if (refreshToken !== null && refreshToken !== '') secret['refreshToken'] = refreshToken;
  if (grant.expiresIn !== null) {
    secret['accessTokenExpiresAt'] = new Date(now.getTime() + grant.expiresIn * 1000).toISOString();
  }
  return secret;
}

/** Whether a stored secret is an OAuth access token that has to be kept fresh. */
export function isRefreshableSecret(secret: Readonly<Record<string, string>>): boolean {
  return (
    (secret['accessToken'] ?? '') !== '' &&
    (secret['refreshToken'] ?? '') !== '' &&
    (secret['accessTokenExpiresAt'] ?? '') !== ''
  );
}

/** True when the access token is expired or within the skew of expiring. */
export function accessTokenStale(secret: Readonly<Record<string, string>>, now: Date): boolean {
  if (!isRefreshableSecret(secret)) return false;
  const expires = Date.parse(secret['accessTokenExpiresAt'] ?? '');
  return Number.isNaN(expires) || expires - ACCESS_TOKEN_SKEW_MS <= now.getTime();
}
