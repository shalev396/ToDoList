/**
 * Google's OAuth and Calendar endpoints (confirmed against Google's OpenID discovery document and
 * the Calendar API reference), as constants.
 *
 * A test may point every one of them at its in-process stand-in for Google
 * (testing/mockGoogle.ts) with setGoogleBaseUrlForTests: a loopback http origin, nothing else. The
 * setter throws in a server, so there it is always Google itself.
 */
import { assertUnderTest } from '../../config/testSwitches.js';

export const GOOGLE_ENDPOINTS = {
  authorize: 'https://accounts.google.com/o/oauth2/v2/auth',
  token: 'https://oauth2.googleapis.com/token',
  revoke: 'https://oauth2.googleapis.com/revoke',
  userinfo: 'https://openidconnect.googleapis.com/v1/userinfo',
  calendar: 'https://www.googleapis.com/calendar/v3',
} as const;

export type GoogleEndpointName = keyof typeof GOOGLE_ENDPOINTS;
export type GoogleEndpoints = Readonly<Record<GoogleEndpointName, string>>;

/** Where the stand-in serves each endpoint, under its origin. */
const MOCK_PATHS: GoogleEndpoints = {
  authorize: '/o/oauth2/v2/auth',
  token: '/token',
  revoke: '/revoke',
  userinfo: '/v1/userinfo',
  calendar: '/calendar/v3',
};

/** `http://127.0.0.1:<port>` or `http://localhost:<port>`, nothing more. */
const LOOPBACK_ORIGIN = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}$/;

let mockEndpoints: GoogleEndpoints | null = null;

/**
 * Tests only (node:test): every Google endpoint points at the stand-in at `baseUrl` (a loopback
 * http origin); null restores Google's. It throws in a server.
 */
export function setGoogleBaseUrlForTests(baseUrl: string | null): void {
  assertUnderTest('setGoogleBaseUrlForTests');
  if (baseUrl === null) {
    mockEndpoints = null;
    return;
  }
  const origin = baseUrl.replace(/\/+$/, '');
  if (!LOOPBACK_ORIGIN.test(origin)) {
    throw new Error(
      'The Google stand-in must be a loopback http origin, e.g. http://127.0.0.1:3998',
    );
  }
  const entries = Object.entries(MOCK_PATHS).map(([name, path]) => [name, `${origin}${path}`]);
  mockEndpoints = Object.fromEntries(entries) as Record<GoogleEndpointName, string>;
}

/** The endpoints to call: Google's, or a test's stand-in. */
export function googleEndpoints(): GoogleEndpoints {
  return mockEndpoints ?? GOOGLE_ENDPOINTS;
}

/** The stand-in's URL for one endpoint while a test points at it; else null. */
export function mockGoogleEndpoint(name: GoogleEndpointName): string | null {
  return mockEndpoints?.[name] ?? null;
}
