/**
 * What every OAuth sign-in shares besides its state (classes/integration/OAuthFlow.ts): the
 * browser-binding cookie, the shape of a state or nonce, the callback URL on the stage's domain,
 * and the callback's redirect to the fixed client page with a code only. Pure: no database.
 */
import { randomBytes } from 'node:crypto';

import { environment } from '../../config/environment.js';
import { assertUnderTest } from '../../config/testSwitches.js';
import type { OAuthErrorCode } from './failure.js';

export { OAuthFailure, type OAuthErrorCode } from './failure.js';

/** The browser-binding cookie: HttpOnly, sent only to the OAuth callbacks. */
export const OAUTH_COOKIE = 'todolist_oauth';
export const OAUTH_COOKIE_PATH = '/api/public/oauth';
/**
 * The binding cookie's attributes: HttpOnly (no script reads it), Secure, SameSite=Lax (the
 * provider's redirect back is a top-level GET, which must carry it), and sent only to the
 * callbacks. A start writes them out in full, typed by this constant (OAuthCookieOptions), so the
 * flags stand where the cookie is set and can't drift from the ones that clear it.
 */
export const OAUTH_COOKIE_ATTRIBUTES = {
  httpOnly: true,
  secure: true,
  sameSite: 'lax',
  path: OAUTH_COOKIE_PATH,
} as const;
/** What a start sets the cookie with: the attributes, and how long the flow may take. */
export type OAuthCookieOptions = typeof OAUTH_COOKIE_ATTRIBUTES & { maxAge: number };
export const OAUTH_LANGUAGES = ['en', 'he'] as const;
export const DEFAULT_LANGUAGE = 'en';
/** A state, verifier or nonce: 32 random bytes, base64url (43 characters). */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** A test's callback origin: a loopback http origin only (the API under test). */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}$/;

export const randomToken = (): string => randomBytes(32).toString('base64url');

let callbackOriginForTests: string | null = null;

/**
 * Tests only (node:test): callbacks go to `origin` (the API under test, a loopback http origin)
 * instead of the stage's domain, so an in-process provider stand-in can send the browser back to
 * it; null restores the domain. It throws in a server.
 */
export function setCallbackOriginForTests(origin: string | null): void {
  assertUnderTest('setCallbackOriginForTests');
  if (origin !== null && !LOOPBACK_ORIGIN.test(origin)) {
    throw new Error('setCallbackOriginForTests takes a loopback http origin');
  }
  callbackOriginForTests = origin;
}

/** The callback URL registered with a provider: the stage's own domain. */
export function callbackUrl(path: string, domainName: string = environment.domainName): string {
  if (callbackOriginForTests !== null) return `${callbackOriginForTests}${path}`;
  return `https://${domainName}${path}`;
}

export const languageOf = (value: string): string =>
  (OAUTH_LANGUAGES as readonly string[]).includes(value) ? value : DEFAULT_LANGUAGE;

/** The fixed client page, with a code only. */
export function oauthErrorLocation(lng: string, code: OAuthErrorCode): string {
  return `/${languageOf(lng)}/integrations?oauth_error=${code}`;
}

export function connectedLocation(lng: string, integrationId: string): string {
  return `/${languageOf(lng)}/integrations?connected=${encodeURIComponent(integrationId)}`;
}
