/**
 * What every OAuth provider flow shares (Google Calendar and the providers of ./providers.ts):
 * the single-use 10-minute state bound to user, workspace and provider, the browser-binding
 * cookie, PKCE S256, and the callback's redirect to the fixed client page with a code only.
 */
import { createHash, randomBytes, timingSafeEqual } from 'node:crypto';

import { environment } from '../../config/environment.js';
import { assertUnderTest } from '../../config/testSwitches.js';
import { OAUTH_STATE_TTL_MS, type OAuthStateData } from '../../models/definitions/OAuthState.js';
import { getOAuthStateRepository } from '../../models/index.js';
import type { Provider } from '../../types/domain.js';
import type { ErrorCode } from '../../types/errorCodes.js';

/** The browser-binding cookie: HttpOnly, sent only to the OAuth callbacks. */
export const OAUTH_COOKIE = 'todolist_oauth';
export const OAUTH_COOKIE_PATH = '/api/public/oauth';
export const OAUTH_LANGUAGES = ['en', 'he'] as const;
export const DEFAULT_LANGUAGE = 'en';
/** A state, verifier or nonce: 32 random bytes, base64url (43 characters). */
export const TOKEN_SHAPE = /^[A-Za-z0-9_-]{43}$/;
/** A test's callback origin: a loopback http origin only (the API under test). */
const LOOPBACK_ORIGIN = /^http:\/\/(?:localhost|127\.0\.0\.1):\d{2,5}$/;

export type OAuthErrorCode = Extract<ErrorCode, `oauth_${string}`>;

export const sha256Hex = (value: string): string =>
  createHash('sha256').update(value).digest('hex');
export const randomToken = (): string => randomBytes(32).toString('base64url');

/** RFC 7636 S256: BASE64URL(SHA256(ASCII(code_verifier))). */
export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

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

/** A failure the callback reports as `?oauth_error=<code>`. */
export class OAuthFailure extends Error {
  readonly code: OAuthErrorCode;

  constructor(code: OAuthErrorCode) {
    super(code);
    this.name = 'OAuthFailure';
    this.code = code;
  }
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

export interface NewOAuthState {
  state: string;
  verifier: string;
  browserNonce: string;
}

/** A fresh state, verifier and browser nonce; only their hashes (and the verifier) are stored. */
export async function createOAuthState(input: {
  workspaceId: string;
  userId: string;
  provider: Provider;
  integrationId: string | null;
  lng: string;
  now: Date;
}): Promise<NewOAuthState> {
  const fresh = { state: randomToken(), verifier: randomToken(), browserNonce: randomToken() };
  await (
    await getOAuthStateRepository()
  ).create(input.workspaceId, {
    stateHash: sha256Hex(fresh.state),
    browserHash: sha256Hex(fresh.browserNonce),
    codeVerifier: fresh.verifier,
    userId: input.userId,
    provider: input.provider,
    integrationId: input.integrationId,
    lng: input.lng,
    createdAt: input.now,
  });
  return fresh;
}

export type ClaimedCallback =
  | { ok: true; record: OAuthStateData; code: string }
  | { ok: false; location: string };

/**
 * The callback's checks, in order: the state exists, is this provider's, unused and younger than
 * 10 minutes; it is then claimed (single use, whatever happens next); the browser holds its
 * nonce; the provider did not report an error; a code is present. A failure is the redirect to
 * answer with.
 */
export async function claimCallback(
  provider: Provider,
  query: Readonly<Record<string, unknown>>,
  browserNonce: string | null,
  now: Date,
): Promise<ClaimedCallback> {
  const fail = (lng: string, code: OAuthErrorCode): ClaimedCallback => ({
    ok: false,
    location: oauthErrorLocation(lng, code),
  });
  const state = typeof query['state'] === 'string' ? query['state'] : '';
  if (!TOKEN_SHAPE.test(state)) return fail(DEFAULT_LANGUAGE, 'oauth_state_invalid');
  const states = await getOAuthStateRepository();
  const record = await states.findByStateHash(sha256Hex(state));
  if (record?.provider !== provider) return fail(DEFAULT_LANGUAGE, 'oauth_state_invalid');
  const { lng } = record;
  if (record.usedAt !== null) return fail(lng, 'oauth_state_used');
  if (now.getTime() - record.createdAt.getTime() > OAUTH_STATE_TTL_MS) {
    return fail(lng, 'oauth_state_expired');
  }
  if (!(await states.claim(record.workspaceId, record.id, now))) {
    return fail(lng, 'oauth_state_used');
  }
  if (
    browserNonce === null ||
    !TOKEN_SHAPE.test(browserNonce) ||
    !sameHash(sha256Hex(browserNonce), record.browserHash)
  ) {
    return fail(lng, 'oauth_state_invalid');
  }
  if (query['error'] !== undefined) {
    return fail(lng, query['error'] === 'access_denied' ? 'oauth_denied' : 'oauth_failed');
  }
  const code = query['code'];
  if (typeof code !== 'string' || code === '' || code.length > 2048) {
    return fail(lng, 'oauth_failed');
  }
  return { ok: true, record, code };
}
