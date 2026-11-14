/**
 * Google service-account auth, for the google_calendar adapter's fixture-mode
 * (demo) calendar (secret `{clientEmail, privateKey}`, the calendar shared with the account). Users
 * connect Google Calendar with Google sign-in (OAuth), never this.
 *
 * Each resource of a run signs an RS256 JWT (RFC 7523: issuer = the account, audience = the token
 * endpoint, one hour) with node:crypto and trades it for an access token through the client's one
 * allow-listed POST, exchangeToken(). The private key is read from `ctx.secret` inside the run and
 * is never kept: only the short-lived access token leaves this module, and only to build headers.
 * In fixtures mode the secret is `{}`: the assertion is empty and a recorded response answers.
 */
import { createPrivateKey, createSign } from 'node:crypto';

import type { Provider } from '../../types/domain.js';
import { GOOGLE_TOKEN_URL, ProviderHttpError } from '../http.js';
import type { AdapterContext } from '../types.js';

export const CALENDAR_READONLY_SCOPE = 'https://www.googleapis.com/auth/calendar.readonly';
export const JWT_BEARER_GRANT = 'urn:ietf:params:oauth:grant-type:jwt-bearer';

/** Google's maximum assertion lifetime: `exp − iat` never exceeds it. */
const ASSERTION_LIFETIME_S = 3600;
/**
 * How far the issue time is set back. Google refuses an assertion issued "in the future" by its
 * own clock; a server running a little fast would otherwise fail auth.
 */
export const CLOCK_SKEW_S = 60;

export interface AssertionClaims {
  clientEmail: string;
  scope: string;
  /** Unix seconds. */
  issuedAt: number;
}

function base64UrlJson(value: object): string {
  return Buffer.from(JSON.stringify(value), 'utf8').toString('base64url');
}

/**
 * A key pasted from an env file or a JSON string can arrive with its newlines escaped (`\n` as two
 * characters). A PEM never contains a backslash, so this changes nothing else.
 */
function unescapeNewlines(pem: string): string {
  return pem.replace(/\\n/g, '\n');
}

/**
 * The signed assertion. A key that cannot sign (malformed, not RSA) is `auth_failed`, so the
 * integration asks for a reconnect; the cause is dropped, so no part of the key reaches a log.
 */
export function signServiceAccountAssertion(
  provider: Provider,
  privateKey: string,
  claims: AssertionClaims,
): string {
  const signingInput = `${base64UrlJson({ alg: 'RS256', typ: 'JWT' })}.${base64UrlJson({
    iss: claims.clientEmail,
    scope: claims.scope,
    aud: GOOGLE_TOKEN_URL,
    iat: claims.issuedAt,
    exp: claims.issuedAt + ASSERTION_LIFETIME_S,
  })}`;
  try {
    const key = createPrivateKey(unescapeNewlines(privateKey));
    if (key.asymmetricKeyType !== 'rsa') throw new Error('not an RSA key');
    const signature = createSign('RSA-SHA256').update(signingInput).sign(key);
    return `${signingInput}.${signature.toString('base64url')}`;
  } catch {
    throw new ProviderHttpError(provider, null, 'auth_failed');
  }
}

/**
 * An access token for `scope`, valid about an hour: one exchange per call. The issue time is the
 * run's `now` minus CLOCK_SKEW_S (so a run signs the same claims whenever it is replayed), and the
 * assertion expires an hour after it.
 */
export async function serviceAccountToken(
  ctx: Pick<AdapterContext, 'client' | 'secret' | 'now'>,
  provider: Provider,
  scope: string,
): Promise<string> {
  const privateKey = ctx.secret['privateKey'] ?? '';
  const assertion =
    privateKey === ''
      ? ''
      : signServiceAccountAssertion(provider, privateKey, {
          clientEmail: ctx.secret['clientEmail'] ?? '',
          scope,
          issuedAt: Math.floor(ctx.now.getTime() / 1000) - CLOCK_SKEW_S,
        });
  const grant = await ctx.client.exchangeToken({ grant_type: JWT_BEARER_GRANT, assertion });
  return grant.accessToken;
}

export function bearerHeaders(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}
