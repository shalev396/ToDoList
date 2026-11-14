/**
 * The OAuth and API endpoints of the providers that connect with OAuth besides Google (GitHub,
 * Jira, ClickUp, Linear), verified against each provider's own documentation (INTEGRATIONS-SETUP.md).
 *
 * A test may point every one of them at its in-process stand-in (testing/mockOAuthProviders.ts)
 * with setOAuthBaseUrlForTests: a loopback http origin, nothing else. The setter throws in a
 * server, so there it is always the provider itself.
 */
import { assertUnderTest } from '../../config/testSwitches.js';

export const OAUTH_PROVIDERS = ['github', 'jira', 'clickup', 'linear'] as const;
export type OAuthProviderId = (typeof OAUTH_PROVIDERS)[number];

export interface OAuthProviderEndpoints {
  authorize: string;
  token: string;
  /** RFC 7009 revocation, where the provider has one. */
  revoke: string | null;
  /** The API's base URL (no trailing slash): identity and resource calls go under it. */
  api: string;
}

export const OAUTH_ENDPOINTS: Readonly<Record<OAuthProviderId, OAuthProviderEndpoints>> = {
  github: {
    authorize: 'https://github.com/login/oauth/authorize',
    token: 'https://github.com/login/oauth/access_token',
    revoke: null,
    api: 'https://api.github.com',
  },
  jira: {
    authorize: 'https://auth.atlassian.com/authorize',
    token: 'https://auth.atlassian.com/oauth/token',
    revoke: null,
    api: 'https://api.atlassian.com',
  },
  clickup: {
    authorize: 'https://app.clickup.com/api',
    token: 'https://api.clickup.com/api/v2/oauth/token',
    revoke: null,
    api: 'https://api.clickup.com/api/v2',
  },
  linear: {
    authorize: 'https://linear.app/oauth/authorize',
    token: 'https://api.linear.app/oauth/token',
    revoke: 'https://api.linear.app/oauth/revoke',
    api: 'https://api.linear.app',
  },
};

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

/** Where the stand-in serves a provider: everything under `/<provider>`. */
function mockEndpoints(origin: string, provider: OAuthProviderId): OAuthProviderEndpoints {
  const base = `${origin}/${provider}`;
  return {
    authorize: `${base}/authorize`,
    token: `${base}/token`,
    revoke: OAUTH_ENDPOINTS[provider].revoke === null ? null : `${base}/revoke`,
    api: `${base}/api`,
  };
}

/** The endpoints to call: the provider's, or a test's stand-in. */
export function oauthEndpoints(provider: OAuthProviderId): OAuthProviderEndpoints {
  return mockOrigin === null ? OAUTH_ENDPOINTS[provider] : mockEndpoints(mockOrigin, provider);
}

/** The stand-in's URL of one provider's token or revoke endpoint while a test points at it. */
export function mockOAuthUrl(provider: OAuthProviderId, name: 'token' | 'revoke'): string | null {
  return mockOrigin === null ? null : mockEndpoints(mockOrigin, provider)[name];
}
