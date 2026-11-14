/**
 * Google Calendar through Google OAuth 2.0 (INTEGRATIONS-SETUP.md §1; TODO.md "Answers"): a Google
 * app separate from sign-in, the authorization-code flow with PKCE, a refresh token sealed in the
 * credential vault.
 *
 * - start (owner): a fresh `state`, PKCE verifier and browser nonce. OAuthStates keeps the SHA-256
 *   of the state and of the nonce, the verifier, the user, the workspace and the provider for 10
 *   minutes. The browser gets the nonce in an HttpOnly cookie (the controller), and the authorize
 *   URL with the state and the S256 challenge.
 * - callback (public: the browser lands there): the state must exist, be Google Calendar's, be
 *   unused and younger than 10 minutes; it is then claimed (single use), and the browser must hold
 *   its nonce, so a flow started by one person can't be finished in another's browser. Then the
 *   code is exchanged with the verifier and the client secret, the account read (`sub`, `email`)
 *   and the integration created or reconnected: one per Google account per workspace (many-to-one:
 *   the same `sub` is a reconnect, another `sub` a new integration). `{refreshToken, scope}` is
 *   sealed with storeCredential.
 * - It always answers with a redirect to the fixed client page `/<lng>/integrations`, with
 *   `?connected=<iid>` or `?oauth_error=<code>`: never a token, a code or a caller-supplied URL.
 *   The access token lives for this one request and is dropped.
 */
import { z } from 'zod';

import { Actor, type ActorOrigin } from '../classes/base/Actor.js';
import { Caller } from '../classes/base/Caller.js';

import { AppError } from '../errors/AppError.js';
import { type OAuthStateData } from '../models/definitions/OAuthState.js';
import { listOAuthCalendars, type GoogleCalendarEntry } from '../gcal/oauthCalendar.js';
import { ProviderHttpError, type ReadOnlyClient } from '../sync/http.js';
import { googleEndpoints } from '../sync/providers/googleEndpoints.js';
import type { WorkspaceContext } from './accessFilter.js';
import {
  GOOGLE_CALENDAR_OAUTH_SCOPES,
  googleOAuthCredentials,
  googleTokenClient,
  REQUIRED_CALENDAR_SCOPES,
} from './googleOAuthClient.js';
import { connectOAuthIntegration } from './integrationConnect.js';
import { findOwnIntegration } from './integrationOwnership.js';
import type { IntegrationActor } from './integrations.js';
import { logger } from './logger.js';
import {
  callbackUrl,
  claimCallback,
  connectedLocation,
  createOAuthState,
  DEFAULT_LANGUAGE,
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  OAUTH_LANGUAGES,
  OAuthFailure,
  oauthErrorLocation,
  type OAuthErrorCode,
} from './oauth/common.js';
import { pkceChallenge } from './crypto/hashing.js';

export {
  OAUTH_COOKIE,
  OAUTH_COOKIE_PATH,
  OAUTH_LANGUAGES,
  oauthErrorLocation,
  pkceChallenge,
  type OAuthErrorCode,
};

const PROVIDER = 'google_calendar';
export const OAUTH_CALLBACK_PATH = '/api/public/oauth/google-calendar/callback';

export const StartOAuthBody = z.strictObject({
  /** Reconnect: the integration it started from (a Google Calendar connected with Google). */
  integrationId: z.string().min(1).max(100).optional(),
  lng: z.enum(OAUTH_LANGUAGES).optional(),
});
export type StartOAuthInput = z.infer<typeof StartOAuthBody>;

export interface OAuthStart {
  authorizeUrl: string;
  /** For the browser-binding cookie only: never in a response body or a log. */
  browserNonce: string;
}

/** The callback URL registered with Google: the stage's own domain. */
export function oauthRedirectUri(domainName?: string): string {
  return callbackUrl(OAUTH_CALLBACK_PATH, domainName);
}

// ─── start ──────────────────────────────────────────────────────────────────

/**
 * A new authorization: editors and owners connect their own (ruling 9). 409 `oauth_unavailable`
 * when this server has no Google Calendar OAuth client. `integrationId` (a reconnect) must be the
 * member's own Google Calendar connected with Google (404 otherwise, any role: ruling 10); its
 * account is offered first (`login_hint`).
 */
export async function startGoogleCalendarOAuth(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  input: StartOAuthInput,
  now: Date = new Date(),
): Promise<OAuthStart> {
  let loginHint: string | null = null;
  if (input.integrationId === undefined) Caller.fromContext(ctx, actor).require('editor');
  else {
    const existing = await findOwnIntegration(ctx, actor.userId, input.integrationId);
    if (existing.provider !== PROVIDER || existing.authMethod !== 'oauth') {
      throw new AppError(400, 'integrationId: not a Google Calendar connected with Google');
    }
    loginHint = existing.label;
  }
  const credentials = await googleOAuthCredentials();
  if (credentials === null) {
    throw new AppError(409, 'Connecting with Google is not set up on this server', {
      code: 'oauth_unavailable',
    });
  }
  const { state, verifier, browserNonce } = await createOAuthState({
    workspaceId: ctx.id,
    userId: actor.userId,
    provider: PROVIDER,
    integrationId: input.integrationId ?? null,
    lng: input.lng ?? DEFAULT_LANGUAGE,
    now,
  });
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: oauthRedirectUri(),
    response_type: 'code',
    scope: GOOGLE_CALENDAR_OAUTH_SCOPES.join(' '),
    access_type: 'offline',
    prompt: 'consent',
    include_granted_scopes: 'true',
    state,
    code_challenge: pkceChallenge(verifier),
    code_challenge_method: 'S256',
  });
  if (loginHint?.includes('@') === true) params.set('login_hint', loginHint);
  return { authorizeUrl: `${googleEndpoints().authorize}?${params.toString()}`, browserNonce };
}

// ─── callback ───────────────────────────────────────────────────────────────

interface GoogleAccount {
  sub: string;
  email: string;
}

const Account = z.object({
  sub: z.string().regex(/^[A-Za-z0-9._-]{1,255}$/),
  email: z.string().max(254).pipe(z.email()),
});

function bearer(accessToken: string): Record<string, string> {
  return { authorization: `Bearer ${accessToken}` };
}

async function readAccount(client: ReadOnlyClient, accessToken: string): Promise<GoogleAccount> {
  const { data } = await client.getJson<unknown>(googleEndpoints().userinfo, bearer(accessToken));
  const parsed = Account.safeParse(data);
  if (!parsed.success) throw new OAuthFailure('oauth_failed');
  return parsed.data;
}

/** The account's primary calendar id, the default to read and push to; null if unreadable. */
async function primaryCalendarId(
  client: ReadOnlyClient,
  accessToken: string,
): Promise<string | null> {
  try {
    const url = `${googleEndpoints().calendar}/users/me/calendarList?minAccessRole=writer`;
    const { data } = await client.getJson<{ items?: unknown }>(url, bearer(accessToken));
    const items = Array.isArray(data.items) ? (data.items as unknown[]) : [];
    for (const item of items) {
      const { id, primary } = (item ?? {}) as { id?: unknown; primary?: unknown };
      if (primary === true && typeof id === 'string' && /^\S{1,255}$/.test(id)) return id;
    }
  } catch {
    // The owner picks the calendars instead.
  }
  return null;
}

/** Best effort: a grant we won't keep (a scope was left out) is handed back to Google. */
async function revokeQuietly(client: ReadOnlyClient, token: string): Promise<void> {
  try {
    await client.revokeToken(token);
  } catch {
    // The grant expires on its own.
  }
}

/** Code → tokens → account → integration and sealed credential. Returns the integration id. */
async function connect(record: OAuthStateData, code: string, origin: ActorOrigin): Promise<string> {
  // The member who started the flow, from the callback request (the audit log's address).
  const actor = Actor.user(record.userId, origin);
  // Still a member; the role (a new integration needs an editor) is connectOAuthIntegration's.
  const ctx = (await Caller.enter(record.workspaceId, actor))?.context ?? null;
  if (ctx === null) throw new OAuthFailure('oauth_not_editor');
  const credentials = await googleOAuthCredentials();
  if (credentials === null) throw new OAuthFailure('oauth_failed');
  const client = googleTokenClient();
  const grant = await client.exchangeToken({
    grant_type: 'authorization_code',
    code,
    code_verifier: record.codeVerifier,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: oauthRedirectUri(),
  });
  const refreshToken = grant.refreshToken;
  if (refreshToken === null) throw new OAuthFailure('oauth_failed');
  const scopes = (grant.scope ?? '').split(/\s+/).filter((scope) => scope !== '');
  if (!REQUIRED_CALENDAR_SCOPES.every((scope) => scopes.includes(scope))) {
    // Google lets the user untick a permission on the consent screen.
    await revokeQuietly(client, refreshToken);
    throw new OAuthFailure('oauth_scope_missing');
  }
  const account = await readAccount(client, grant.accessToken);
  const primary = await primaryCalendarId(client, grant.accessToken);
  const config =
    primary === null
      ? { calendars: [] }
      : { calendars: [{ id: primary, mode: 'two_way' }], targetCalendarId: primary };

  const { integration } = await connectOAuthIntegration(ctx, actor, {
    provider: PROVIDER,
    accountId: account.sub,
    label: account.email,
    config,
    topicSlug: 'personal',
    mode: 'read_write',
    secret: { refreshToken, scope: scopes.join(' ') },
    scopes,
    reconnectIntegrationId: record.integrationId,
  });
  return integration.id;
}

/**
 * The public callback: always a redirect to `/<lng>/integrations` (relative: the page's own
 * origin), with `connected` or an `oauth_error` code. `browserNonce` is the binding cookie's
 * value (null when the browser sent none); `origin`, the callback request's address and user
 * agent, for the audit log.
 */
export async function completeGoogleCalendarOAuth(
  query: Readonly<Record<string, unknown>>,
  browserNonce: string | null,
  now: Date = new Date(),
  origin: ActorOrigin = {},
): Promise<string> {
  const claimed = await claimCallback(PROVIDER, query, browserNonce, now);
  if (!claimed.ok) return claimed.location;
  const { record, code } = claimed;
  const { lng } = record;
  try {
    return connectedLocation(lng, await connect(record, code, origin));
  } catch (error) {
    if (error instanceof OAuthFailure) return oauthErrorLocation(lng, error.code);
    // A name and a status at most: provider answers and tokens never reach the log.
    logger.warn('A Google Calendar connection failed', {
      workspaceId: record.workspaceId,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(typeof (error as { status?: unknown }).status === 'number'
        ? { status: (error as { status: number }).status }
        : {}),
    });
    return oauthErrorLocation(lng, 'oauth_failed');
  }
}

// ─── the calendar picker ────────────────────────────────────────────────────

/**
 * Its owner only: the calendars of a Google Calendar connected with Google, from Google
 * (calendarList), for the picker. 404 for another member's; 409 for another kind of integration,
 * or when Google refuses the grant (reconnect); 502 when Google does not answer.
 */
export async function listGoogleCalendars(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
): Promise<GoogleCalendarEntry[]> {
  const integration = await findOwnIntegration(ctx, userId, integrationId);
  if (integration.provider !== PROVIDER || integration.authMethod !== 'oauth') {
    throw new AppError(409, 'Only a Google Calendar connected with Google lists its calendars');
  }
  try {
    return await listOAuthCalendars(integration);
  } catch (error) {
    if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
      throw new AppError(409, 'Google refused the connection: reconnect Google Calendar');
    }
    logger.warn('Google calendars could not be listed', {
      integrationId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError(502, 'Google Calendar did not answer. Try again in a moment.');
  }
}
