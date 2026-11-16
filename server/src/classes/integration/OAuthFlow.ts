/**
 * One OAuth sign-in, start to callback (an OAuthStates row): the same flow for every provider that
 * connects with OAuth (Google Calendar, GitHub, Jira, ClickUp, Linear). What differs between them
 * is the provider's OAuth strategy (its definition's `auth.oauth`: endpoints, scopes, PKCE, the
 * secret it seals, how it names the account); the routes and their callback URLs stay as the
 * operator registered them.
 *
 * - start (`start`, editors and owners connect their own: ruling 9): a single-use 10-minute state
 *   bound to user, workspace and provider, a browser nonce for the HttpOnly cookie, PKCE S256 where
 *   the provider supports it, read-only scopes. OAuthStates keeps only the SHA-256 of the state and
 *   of the nonce, and the verifier.
 * - callback (`consume`, public: the browser lands there): the state must exist, be this
 *   provider's, unused and younger than 10 minutes; it is then claimed (single use), and the
 *   browser must hold its nonce, so a flow started by one person can't be finished in another's
 *   browser. The code is exchanged at the allow-listed token URL, the account read, and
 *   Integration.connectOAuth (the one integration writer) creates or reconnects the integration:
 *   read-only, like every new connection. It always answers with a redirect to the fixed client
 *   page `/<lng>/integrations`, with `?connected=<iid>` or `?oauth_error=<code>`: never a token, a
 *   code or a caller-supplied URL.
 * Nothing secret reaches a log, an error or a response: a failure logs its class name and status.
 */
import { timingSafeEqual } from 'node:crypto';

import { Actor, type ActorOrigin } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import { environment } from '../../config/environment.js';
import { AppError } from '../../errors/AppError.js';
import { OAUTH_STATE_TTL_MS, type OAuthStateData } from '../../models/definitions/OAuthState.js';
import { getOAuthStateRepository } from '../../models/index.js';
import { sha256Hex } from '../../services/crypto/hashing.js';
import { logger } from '../../services/logger.js';
import {
  callbackUrl,
  connectedLocation,
  DEFAULT_LANGUAGE,
  OAuthFailure,
  oauthErrorLocation,
  randomToken,
  TOKEN_SHAPE,
  type OAuthErrorCode,
} from '../../services/oauth/common.js';
import type { ReadOnlyClient } from '../../sync/http.js';
import type { Provider } from '../../types/domain.js';
import {
  OAUTH_SIGN_IN_PROVIDERS,
  type OAuthProviderInfo,
  type OAuthProvidersResponse,
} from '../../types/integrations.js';
import type { OAuthAuth } from './auth/OAuthAuth.js';
import { definitionOf } from './definitions/index.js';
import { Integration } from './Integration.js';

/** A provider class whose definition connects with OAuth sign-in. */
export interface OAuthIntegrationClass {
  readonly definition: { readonly auth: { readonly oauth?: OAuthAuth } };
}

export interface OAuthStartInput {
  /** Reconnect: the integration it started from (the member's own OAuth one of this provider). */
  integrationId?: string | undefined;
  lng?: string | undefined;
  /**
   * H5: also ask for the provider's write scope (Jira `write:jira-work`, Linear `write`),
   * for the consent a create asked for; read stays the default of every connection.
   */
  includeWrite?: boolean | undefined;
}

export interface OAuthStart {
  authorizeUrl: string;
  /** For the browser-binding cookie only: never in a response body or a log. */
  browserNonce: string;
}

/** What the provider's redirect brought: its query, and the browser's binding cookie (or null). */
export interface OAuthCallback {
  query: Readonly<Record<string, unknown>>;
  browserNonce: string | null;
}

/** The providers' setup, in the order the page lists them: the shared routes' four, then Google. */
const SETUP_ORDER: readonly Provider[] = [...OAUTH_SIGN_IN_PROVIDERS, 'google_calendar'];

function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === 32 && right.length === 32 && timingSafeEqual(left, right);
}

/** Best effort: a grant we won't keep (a scope was left out) is handed back to the provider. */
async function revokeQuietly(client: ReadOnlyClient, token: string): Promise<void> {
  try {
    await client.revokeToken(token);
  } catch {
    // The grant expires on its own.
  }
}

export class OAuthFlow {
  readonly #record: OAuthStateData;
  readonly #oauth: OAuthAuth;

  private constructor(record: OAuthStateData, oauth: OAuthAuth) {
    this.#record = record;
    this.#oauth = oauth;
  }

  /**
   * A new authorization for `integrationClass`'s provider: editors and owners connect their own
   * (ruling 9). 409 `oauth_unavailable` when this server has no OAuth app for it. `integrationId`
   * (a reconnect) must be the member's own OAuth connection of this provider (404 otherwise, any
   * role: ruling 10); where the provider takes a hint, its account is offered first.
   */
  static async start(
    caller: Caller,
    integrationClass: OAuthIntegrationClass,
    input: OAuthStartInput,
    now: Date = new Date(),
  ): Promise<OAuthStart> {
    const oauth = OAuthFlow.#oauthOf(integrationClass);
    const provider = oauth.provider;
    let loginHint: string | null = null;
    if (input.integrationId === undefined) caller.require('editor');
    else {
      const existing = await Integration.findOwn(caller, input.integrationId);
      if (existing.provider !== provider || existing.authKind !== 'oauth') {
        throw new AppError(400, oauth.messages.notReconnectable);
      }
      loginHint = existing.label;
    }
    const credentials = await oauth.credentials();
    if (credentials === null) {
      throw new AppError(409, oauth.messages.unavailable, { code: 'oauth_unavailable' });
    }
    const fresh = { state: randomToken(), verifier: randomToken(), browserNonce: randomToken() };
    await (
      await getOAuthStateRepository()
    ).create(caller.workspaceId, {
      stateHash: sha256Hex(fresh.state),
      browserHash: sha256Hex(fresh.browserNonce),
      codeVerifier: fresh.verifier,
      userId: caller.userId,
      provider,
      integrationId: input.integrationId ?? null,
      lng: input.lng ?? DEFAULT_LANGUAGE,
      createdAt: now,
    });
    return {
      authorizeUrl: oauth.authorizeUrl({
        clientId: credentials.clientId,
        redirectUri: callbackUrl(oauth.callbackPath),
        state: fresh.state,
        verifier: fresh.verifier,
        // A provider without write scopes (GitHub, ClickUp) has nothing more to ask for.
        includeWrite: input.includeWrite === true && oauth.writeScopes.length > 0,
        loginHint,
      }),
      browserNonce: fresh.browserNonce,
    };
  }

  /**
   * The public callback: always a redirect to `/<lng>/integrations` (relative: the page's own
   * origin), with `connected` or an `oauth_error` code. `origin`, the callback request's address
   * and user agent, is the audit log's.
   */
  static async consume(
    integrationClass: OAuthIntegrationClass,
    callback: OAuthCallback,
    now: Date = new Date(),
    origin: ActorOrigin = {},
  ): Promise<string> {
    const oauth = OAuthFlow.#oauthOf(integrationClass);
    // GitHub, after an install: no state of ours, nothing to exchange; the user lands back.
    if (oauth.landsWithoutState(callback.query)) return `/${DEFAULT_LANGUAGE}/integrations`;
    const claimed = await OAuthFlow.#claim(oauth, callback, now);
    if (claimed.flow === null) return claimed.location;
    const { flow, code } = claimed;
    const { lng } = flow.#record;
    try {
      return connectedLocation(lng, await flow.#complete(code, now, origin));
    } catch (error) {
      if (error instanceof OAuthFailure) return oauthErrorLocation(lng, error.code);
      // A name and a status at most: provider answers, codes and tokens never reach the log.
      const status = (error as { status?: unknown } | null)?.status;
      logger.warn('An OAuth connection failed', {
        provider: oauth.provider,
        workspaceId: flow.#record.workspaceId,
        errorName: error instanceof Error ? error.name : typeof error,
        ...(typeof status === 'number' ? { status } : {}),
      });
      return oauthErrorLocation(lng, 'oauth_failed');
    }
  }

  /**
   * Any member: whether each provider can sign in on this stage (editors and owners connect their
   * own; a viewer may reconnect their own), and what each provider can do (capabilities). No
   * secret.
   */
  static async providers(caller: Caller): Promise<OAuthProvidersResponse> {
    caller.require('viewer');
    const providers = await Promise.all(
      SETUP_ORDER.flatMap((provider) => {
        const oauth = definitionOf(provider)?.auth.oauth;
        return oauth === undefined ? [] : [OAuthFlow.#setup(oauth)];
      }),
    );
    return { stage: environment.env, providers, capabilities: Integration.capabilitiesOf() };
  }

  static async #setup(oauth: OAuthAuth): Promise<OAuthProviderInfo> {
    // A secret that can't be read or has the wrong shape marks only this provider as not
    // configured (appSecrets.ts logged the kind of failure); the rest of the list still answers.
    const credentials = await oauth.credentials().catch(() => null);
    return {
      provider: oauth.provider,
      configured: credentials !== null,
      installUrl: oauth.installUrl(credentials),
    };
  }

  static #oauthOf(integrationClass: OAuthIntegrationClass): OAuthAuth {
    const oauth = integrationClass.definition.auth.oauth;
    if (oauth === undefined) throw new AppError(404, 'Not found');
    return oauth;
  }

  /**
   * The callback's checks, in order: the state exists, is this provider's, unused and younger
   * than 10 minutes; it is then claimed (single use, whatever happens next); the browser holds
   * its nonce; the provider did not report an error; a code is present. A failure is the
   * redirect to answer with.
   */
  static async #claim(
    oauth: OAuthAuth,
    { query, browserNonce }: OAuthCallback,
    now: Date,
  ): Promise<{ flow: OAuthFlow; code: string } | { flow: null; location: string }> {
    const fail = (lng: string, code: OAuthErrorCode): { flow: null; location: string } => ({
      flow: null,
      location: oauthErrorLocation(lng, code),
    });
    const state = typeof query['state'] === 'string' ? query['state'] : '';
    if (!TOKEN_SHAPE.test(state)) return fail(DEFAULT_LANGUAGE, 'oauth_state_invalid');
    const states = await getOAuthStateRepository();
    const record = await states.findByStateHash(sha256Hex(state));
    if (record?.provider !== oauth.provider) return fail(DEFAULT_LANGUAGE, 'oauth_state_invalid');
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
    return { flow: new OAuthFlow(record, oauth), code };
  }

  /** Code → grant → account → integration and sealed credential. Returns the integration id. */
  async #complete(code: string, now: Date, origin: ActorOrigin): Promise<string> {
    const record = this.#record;
    const oauth = this.#oauth;
    // The member who started the flow, from the callback request (the audit log's address).
    const actor = Actor.user(record.userId, origin);
    // Still a member; the role (a new integration needs an editor) is Integration.connectOAuth's.
    const caller = await Caller.enter(record.workspaceId, actor);
    if (caller === null) throw new OAuthFailure('oauth_not_editor');
    const credentials = await oauth.credentials();
    if (credentials === null) throw new OAuthFailure('oauth_failed');
    const client = oauth.client();
    const grant = await oauth.exchangeCode(
      client,
      { code, verifier: record.codeVerifier, redirectUri: callbackUrl(oauth.callbackPath) },
      credentials,
    );
    // A grant that would stop working (no refresh token where one is needed) is not kept.
    if (!oauth.grantUsable(grant)) throw new OAuthFailure('oauth_failed');
    const scopes = oauth.scopesOf(grant);
    if (oauth.lacksRequiredScope(scopes)) {
      // Google lets the user untick a permission on the consent screen.
      await revokeQuietly(client, grant.refreshToken ?? grant.accessToken);
      throw new OAuthFailure('oauth_scope_missing');
    }
    const identity = await oauth.identify(client, grant.accessToken);
    const { integration } = await Integration.connectOAuth(caller, {
      provider: oauth.provider,
      accountId: identity.accountId,
      label: identity.label,
      config: identity.config,
      topicSlug: identity.topicSlug,
      secret: oauth.secretFromGrant(grant, scopes, now),
      scopes,
      reconnectIntegrationId: record.integrationId,
    });
    return integration.id;
  }
}
