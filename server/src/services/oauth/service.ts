/**
 * OAuth sign-in for GitHub, Jira, ClickUp and Linear (INTEGRATIONS-SETUP.md §3 to §6), the same
 * flow as Google Calendar's (services/googleCalendarOAuth.ts) over the shared machinery of
 * ./common.ts:
 * - start (owner): a single-use 10-minute state bound to user, workspace and provider, a browser
 *   nonce for the HttpOnly cookie, PKCE S256 where the provider supports it, read-only scopes;
 * - callback (public): the state checks (claimCallback), the code exchange at the allow-listed
 *   token URL, the account read, then connectOAuthIntegration, the one shared integration writer;
 *   always a redirect to the fixed client page with `?connected=` or `?oauth_error=` and no token;
 * - the grant's resources (Jira sites, ClickUp workspaces) for the owner to pick from;
 * - disconnect: the grant is revoked where the provider has an endpoint (Linear).
 * Nothing secret reaches a log, an error or a response: a failure logs its class name and status.
 */
import { z } from 'zod';

import { environment } from '../../config/environment.js';
import { AppError } from '../../errors/AppError.js';
import { ProviderHttpError } from '../../sync/http.js';
import type { OAuthProviderId } from '../../sync/providers/oauthEndpoints.js';
import { oauthEndpoints } from '../../sync/providers/oauthEndpoints.js';
import type { WorkspaceContext } from '../accessFilter.js';
import { connectOAuthIntegration } from '../integrationConnect.js';
import { findOwnIntegration } from '../integrationOwnership.js';
import { assertRole, type IntegrationActor } from '../integrations.js';
import { googleOAuthCredentials } from '../googleOAuthClient.js';
import { logger } from '../logger.js';
import { getWorkspaceContext } from '../workspaceContext.js';
import { oauthAppCredentials, oauthClient } from './client.js';
import {
  callbackUrl,
  claimCallback,
  connectedLocation,
  createOAuthState,
  DEFAULT_LANGUAGE,
  OAUTH_LANGUAGES,
  OAuthFailure,
  oauthErrorLocation,
  pkceChallenge,
} from './common.js';
import type {
  OAuthProviderInfo,
  OAuthProvidersResponse,
  OAuthResource,
} from '../../types/integrations.js';
import { readGrantResources } from './grants.js';
import { OAUTH_PROVIDER_DEFS, type OAuthProviderDef } from './providers.js';

export type { OAuthProviderInfo, OAuthProvidersResponse, OAuthResource };
import { oauthSecretFromGrant } from './secret.js';

export const StartProviderOAuthBody = z.strictObject({
  /** Reconnect: the integration it started from. */
  integrationId: z.string().min(1).max(100).optional(),
  lng: z.enum(OAUTH_LANGUAGES).optional(),
  /**
   * H5: also ask for the provider's write scope (Jira `write:jira-work`, Linear `issues:create`),
   * so the user can create to-dos there. Used for the consent a create asked for; read stays the
   * default of every connection.
   */
  includeWrite: z.boolean().optional(),
});
export type StartProviderOAuthInput = z.infer<typeof StartProviderOAuthBody>;

export interface ProviderOAuthStart {
  authorizeUrl: string;
  /** For the browser-binding cookie only: never in a response body or a log. */
  browserNonce: string;
}

/** `/api/public/oauth/<provider>/callback`: the URL the operator registers at the provider. */
export const providerCallbackPath = (provider: OAuthProviderId): string =>
  `/api/public/oauth/${provider}/callback`;

export const providerRedirectUri = (provider: OAuthProviderId): string =>
  callbackUrl(providerCallbackPath(provider));

// ─── start ──────────────────────────────────────────────────────────────────

/**
 * Editors and owners connect their own (ruling 9). 409 `oauth_unavailable` when this server has
 * no OAuth app for the provider. `integrationId` (a reconnect) must be the member's own OAuth
 * connection of this provider (404 otherwise, any role: ruling 10).
 */
export async function startProviderOAuth(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  provider: OAuthProviderId,
  input: StartProviderOAuthInput,
  now: Date = new Date(),
): Promise<ProviderOAuthStart> {
  const def = OAUTH_PROVIDER_DEFS[provider];
  if (input.includeWrite === true && def.writeScopes.length === 0) {
    throw new AppError(400, `includeWrite: ${provider} has no scope to ask for`);
  }
  if (input.integrationId === undefined) assertRole(ctx, 'editor');
  else {
    const existing = await findOwnIntegration(ctx, actor.userId, input.integrationId);
    if (existing.provider !== provider || existing.authMethod !== 'oauth') {
      throw new AppError(400, `integrationId: not a ${provider} connected with OAuth`);
    }
  }
  const credentials = await oauthAppCredentials(provider);
  if (credentials === null) {
    throw new AppError(409, `Signing in with ${provider} is not set up on this server`, {
      code: 'oauth_unavailable',
    });
  }
  const { state, verifier, browserNonce } = await createOAuthState({
    workspaceId: ctx.id,
    userId: actor.userId,
    provider,
    integrationId: input.integrationId ?? null,
    lng: input.lng ?? DEFAULT_LANGUAGE,
    now,
  });
  const params = new URLSearchParams({
    client_id: credentials.clientId,
    redirect_uri: providerRedirectUri(provider),
    state,
  });
  if (def.sendResponseType) params.set('response_type', 'code');
  const scopes = input.includeWrite === true ? [...def.scopes, ...def.writeScopes] : def.scopes;
  // Linear takes its scopes comma separated; the others space separated.
  if (scopes.length > 0) params.set('scope', scopes.join(provider === 'linear' ? ',' : ' '));
  for (const [name, value] of Object.entries(def.authorizeParams)) params.set(name, value);
  if (def.pkce) {
    params.set('code_challenge', pkceChallenge(verifier));
    params.set('code_challenge_method', 'S256');
  }
  return {
    authorizeUrl: `${oauthEndpoints(provider).authorize}?${params.toString()}`,
    browserNonce,
  };
}

// ─── callback ───────────────────────────────────────────────────────────────

/** Code → tokens → account → integration and sealed credential. Returns the integration id. */
async function connect(
  def: OAuthProviderDef,
  record: {
    workspaceId: string;
    userId: string;
    codeVerifier: string;
    integrationId: string | null;
  },
  code: string,
  now: Date,
): Promise<string> {
  // Still a member; the role (a new integration needs an editor) is connectOAuthIntegration's.
  const ctx = await getWorkspaceContext(record.workspaceId, record.userId);
  if (ctx === null) throw new OAuthFailure('oauth_not_editor');
  const credentials = await oauthAppCredentials(def.id);
  if (credentials === null) throw new OAuthFailure('oauth_failed');
  const client = oauthClient(def.id);
  const form: Record<string, string> = {
    grant_type: 'authorization_code',
    code,
    client_id: credentials.clientId,
    client_secret: credentials.clientSecret,
    redirect_uri: providerRedirectUri(def.id),
  };
  if (def.pkce) form['code_verifier'] = record.codeVerifier;
  const grant = await client.exchangeToken(form, { format: def.tokenFormat });
  // An expiring token without a refresh token would stop working within hours.
  if (grant.expiresIn !== null && grant.refreshToken === null && def.refreshRequired) {
    throw new OAuthFailure('oauth_failed');
  }
  const identity = await def.identify(client, grant.accessToken);
  const scopes = (grant.scope ?? '').split(/[\s,]+/).filter((scope) => scope !== '');
  const actor: IntegrationActor = { userId: record.userId, agentId: null };
  const { integration } = await connectOAuthIntegration(ctx, actor, {
    provider: def.id,
    accountId: identity.accountId,
    label: identity.label,
    config: identity.config,
    topicSlug: identity.topicSlug,
    mode: 'read',
    secret: oauthSecretFromGrant(grant, null, now),
    scopes,
    githubLogin: identity.githubLogin,
    reconnectIntegrationId: record.integrationId,
  });
  return integration.id;
}

/**
 * The public callback: always a redirect to `/<lng>/integrations` (relative: the page's own
 * origin), with `connected` or an `oauth_error` code. `browserNonce` is the binding cookie's
 * value (null when the browser sent none).
 */
export async function completeProviderOAuth(
  provider: OAuthProviderId,
  query: Readonly<Record<string, unknown>>,
  browserNonce: string | null,
  now: Date = new Date(),
): Promise<string> {
  // GitHub, after an install with "Request user authorization during installation": it starts the
  // web flow itself, with a code and no state of ours. Nothing is exchanged; the user lands back
  // on the page (their connection already exists, the install only widened what it can read).
  if (
    provider === 'github' &&
    query['state'] === undefined &&
    (query['installation_id'] !== undefined || query['setup_action'] !== undefined)
  ) {
    return `/${DEFAULT_LANGUAGE}/integrations`;
  }
  const claimed = await claimCallback(provider, query, browserNonce, now);
  if (!claimed.ok) return claimed.location;
  const { record, code } = claimed;
  const { lng } = record;
  try {
    return connectedLocation(lng, await connect(OAUTH_PROVIDER_DEFS[provider], record, code, now));
  } catch (error) {
    if (error instanceof OAuthFailure) return oauthErrorLocation(lng, error.code);
    // A name and a status at most: provider answers, codes and tokens never reach the log.
    logger.warn('An OAuth connection failed', {
      provider,
      workspaceId: record.workspaceId,
      errorName: error instanceof Error ? error.name : typeof error,
      ...(error instanceof ProviderHttpError && error.status !== null
        ? { status: error.status }
        : {}),
    });
    return oauthErrorLocation(lng, 'oauth_failed');
  }
}

// ─── setup information and the grant's resources ────────────────────────────

async function providerInfo(def: OAuthProviderDef): Promise<OAuthProviderInfo> {
  const credentials = await oauthAppCredentials(def.id);
  const slug = credentials?.appSlug;
  return {
    provider: def.id,
    configured: credentials !== null,
    installUrl:
      def.id === 'github'
        ? slug === undefined
          ? 'https://github.com/settings/installations'
          : `https://github.com/apps/${slug}/installations/new`
        : null,
  };
}

/**
 * Any member: whether each provider (Google Calendar too) can sign in on this stage, for the
 * cards (editors and owners connect their own; a viewer may reconnect their own). No secret.
 */
export async function listOAuthProviders(ctx: WorkspaceContext): Promise<OAuthProvidersResponse> {
  assertRole(ctx, 'viewer');
  const providers = await Promise.all(Object.values(OAUTH_PROVIDER_DEFS).map(providerInfo));
  const google = (await googleOAuthCredentials()) !== null;
  return {
    stage: environment.env,
    providers: [
      ...providers,
      { provider: 'google_calendar', configured: google, installUrl: null },
    ],
  };
}

/**
 * Its owner only: what a Jira (sites) or ClickUp (workspaces) grant can read, live from the
 * provider, for them to pick from. 404 for another member's; 409 for another kind of integration,
 * or when the provider refused the grant (reconnect); 502 when it does not answer.
 */
export async function listOAuthResources(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
): Promise<OAuthResource[]> {
  const integration = await findOwnIntegration(ctx, userId, integrationId);
  const { provider } = integration;
  if (integration.authMethod !== 'oauth' || (provider !== 'jira' && provider !== 'clickup')) {
    throw new AppError(409, 'Only a Jira or ClickUp connected with OAuth lists its resources');
  }
  try {
    return await readGrantResources(integration.id, provider);
  } catch (error) {
    if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
      throw new AppError(409, `${provider} refused the connection: reconnect it`);
    }
    logger.warn('OAuth resources could not be listed', {
      integrationId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError(502, `${provider} did not answer. Try again in a moment.`);
  }
}

export const OAUTH_PROVIDER_IDS = Object.keys(OAUTH_PROVIDER_DEFS) as OAuthProviderId[];
