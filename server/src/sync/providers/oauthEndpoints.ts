/**
 * The test stand-in for the providers that connect with OAuth besides Google (GitHub, Jira,
 * ClickUp, Linear). Each provider's own endpoints are its definition's
 * (classes/integration/definitions/*: the OAuth strategy); this module only knows where a test's
 * in-process stand-in (testing/mockOAuthProviders.ts) serves them.
 *
 * setOAuthBaseUrlForTests points every one of them at a loopback http origin, nothing else. The
 * setter throws in a server, so there it is always the provider itself.
 */
import { assertUnderTest } from '../../config/testSwitches.js';
import { OAUTH_SIGN_IN_PROVIDERS, type OAuthSignInProvider } from '../../types/integrations.js';

export const OAUTH_PROVIDERS = OAUTH_SIGN_IN_PROVIDERS;
export type OAuthProviderId = OAuthSignInProvider;

export interface OAuthProviderEndpoints {
  authorize: string;
  token: string;
  /** RFC 7009 revocation, where the provider has one. */
  revoke: string | null;
  /** The API's base URL (no trailing slash): identity and resource calls go under it. */
  api: string;
}

export function isOAuthProviderId(value: unknown): value is OAuthProviderId {
  return typeof value === 'string' && (OAUTH_PROVIDERS as readonly string[]).includes(value);
}

/** `http://127.0.0.1:<port>` or `http://localhost:<port>`, nothing more. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

let mockOrigin: string | null = null;

/**
 * Tests only (node:test): every endpoint points at the stand-in at `baseUrl` (a loopback http
 * origin); null restores the providers'. It throws in a server.
 */
export function setOAuthBaseUrlForTests(baseUrl: string | null): void {
  assertUnderTest('setOAuthBaseUrlForTests');
  if (baseUrl === null) {
    mockOrigin = null;
    return;
  }
  const origin = baseUrl.replace(/\/+$/, '');
  if (!LOOPBACK_ORIGIN.test(origin)) {
    throw new Error(
      'The OAuth stand-in must be a loopback http origin, e.g. http://127.0.0.1:3997',
    );
  }
  mockOrigin = origin;
}

/** The stand-in's origin while a test points at it; else null (always null in a server). */
export function oauthMockOrigin(): string | null {
  return mockOrigin;
}

/**
 * The endpoints to call: the provider's own (`real`), or, while a test points at the stand-in,
 * where it serves them (everything under `/<provider>`).
 */
export function standInEndpoints(
  provider: OAuthProviderId,
  real: OAuthProviderEndpoints,
): OAuthProviderEndpoints {
  if (mockOrigin === null) return real;
  const base = `${mockOrigin}/${provider}`;
  return {
    authorize: `${base}/authorize`,
    token: `${base}/token`,
    revoke: real.revoke === null ? null : `${base}/revoke`,
    api: `${base}/api`,
  };
}
