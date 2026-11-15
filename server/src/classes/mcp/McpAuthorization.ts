/**
 * MCP sign-in, the member's side (OAuth 2.1 authorization code with PKCE, RFC 7636 and RFC 9207):
 * - `start`: validates the client's authorization request and stores it for 10 minutes. A bad
 *   client or redirect URI is never redirected to (OAuthError, shown as a 400 page); any other
 *   fault goes back to the client as `error=`, with `state` and `iss`;
 * - `describe` / `approve` / `deny`: the consent page. The member picks one workspace and scopes
 *   their role permits (and, on the read-only resource, only read scopes); `approve` issues a
 *   single-use `elc_` code, stored as its SHA-256 only;
 * - `exchange`: the token endpoint's code grant. The code must be approved, unexpired, and match
 *   the client, redirect URI and PKCE verifier. It is consumed by one atomic update, so a code can
 *   never make two grants; presented again it revokes the grant it made (a leaked code).
 */
import { randomBytes } from 'node:crypto';

import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { OAuthError, type OAuthErrorCode } from '../../errors/OAuthError.js';
import { consentPageUrl, mcpIssuer, mcpResource } from '../../mcp/oauth/urls.js';
import { READ_ONLY_SCOPES, ROLE_SCOPES } from '../../mcp/auth/scopes.js';
import type { McpAuthRequestData } from '../../models/definitions/McpAuthRequest.js';
import { getAgentKeyRepository, getMcpAuthRequestRepository } from '../../models/index.js';
import { pkceChallenge, sha256Hex } from '../../services/crypto/hashing.js';
import { AGENT_SCOPES, type AgentScope, type Role } from '../../types/domain.js';
import { AgentKey, type IssuedTokens } from '../AgentKey.js';
import { Actor, type ActorOrigin, type ActorRef } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import { Workspace } from '../workspace/Workspace.js';
import { McpClient } from './McpClient.js';

/** The raw query of GET /authorize. */
export type AuthorizeParams = Record<string, string | undefined>;

export interface ConsentWorkspace {
  id: string;
  name: string;
  role: Role;
  /** What this role may give an agent here (read scopes only on the read-only resource). */
  allowed: AgentScope[];
  /** What the page ticks first: the requested scopes that are allowed, minus the dangerous two. */
  preselected: AgentScope[];
  /** The member already holds the most agents allowed here. */
  atCap: boolean;
}

export interface ConsentView {
  clientName: string;
  /** Where the member goes back to, host only (what the page shows to say who is asking). */
  redirectHost: string;
  readonly: boolean;
  requested: AgentScope[];
  workspaces: ConsentWorkspace[];
}

export interface ExchangeInput {
  code: string;
  codeVerifier: string;
  clientId: string;
  redirectUri: string;
  resource?: string | undefined;
}

const REQUEST_TTL_MS = 10 * 60 * 1000;
const CODE_TTL_MS = 10 * 60 * 1000;
const CODE_PREFIX = 'elc_';
const NAME_MAX = 80;
const STATE_MAX = 1024;
const DEFAULT_SCOPES: readonly AgentScope[] = ['read', 'items:write', 'builder:write'];
/** Never ticked for the member: they must choose these on purpose. */
const NEVER_PRESELECTED: readonly AgentScope[] = ['providers:create', 'builder:publish'];
/** RFC 7636 section 4.1/4.2: 43 to 128 unreserved characters. */
const PKCE_PATTERN = /^[A-Za-z0-9\-._~]{43,128}$/;

function expired(): AppError {
  return new AppError(404, 'This sign-in request has expired', { code: 'request_expired' });
}

function invalidGrant(): OAuthError {
  return new OAuthError('invalid_grant', 'The authorization code is invalid or expired');
}

function isReadonly(resource: string): boolean {
  return resource === mcpResource(true);
}

/** The scopes a role may give on a resource. */
function allowedScopes(role: Role, resource: string): AgentScope[] {
  const permitted = ROLE_SCOPES[role];
  return AGENT_SCOPES.filter(
    (scope) =>
      permitted.includes(scope) && (!isReadonly(resource) || READ_ONLY_SCOPES.includes(scope)),
  );
}

function parseScopes(scope: string | undefined): AgentScope[] {
  const named = new Set((scope ?? '').split(/\s+/));
  const known = AGENT_SCOPES.filter((candidate) => named.has(candidate));
  return known.length > 0 ? known : [...DEFAULT_SCOPES];
}

/** `redirectUri` with the answer's parameters added to its query (an existing query is kept). */
function redirectWith(
  redirectUri: string,
  state: string | null,
  answer: Record<string, string>,
): { redirectTo: string } {
  const url = new URL(redirectUri);
  for (const [key, value] of Object.entries(answer)) url.searchParams.set(key, value);
  if (state !== null) url.searchParams.set('state', state);
  url.searchParams.set('iss', mcpIssuer());
  return { redirectTo: url.toString() };
}

async function loadPending(id: string): Promise<McpAuthRequestData> {
  const data = await (await getMcpAuthRequestRepository()).findById(id);
  if (data?.status !== 'pending' || data.expiresAt.getTime() <= Date.now()) {
    throw expired();
  }
  return data;
}

// eslint-disable-next-line @typescript-eslint/no-extraneous-class -- a namespace of the sign-in steps
export class McpAuthorization {
  /** Validates the authorization request and stores it; `redirectTo` is the consent page. */
  static async start(params: AuthorizeParams): Promise<{ redirectTo: string }> {
    const clientId = params['client_id'];
    if (clientId === undefined || clientId === '') throw new OAuthError('invalid_client');
    const client = await McpClient.resolve(clientId);
    const redirectUri = params['redirect_uri'];
    if (redirectUri === undefined || !client.allowsRedirect(redirectUri)) {
      throw new OAuthError('invalid_request', 'redirect_uri is not registered for this client');
    }

    const state = params['state'] ?? null;
    const fail = (code: OAuthErrorCode): { redirectTo: string } =>
      redirectWith(redirectUri, state !== null && state.length <= STATE_MAX ? state : null, {
        error: code,
      });

    if (state !== null && state.length > STATE_MAX) return fail('invalid_request');
    if (params['response_type'] !== 'code') return fail('invalid_request');
    const challenge = params['code_challenge'];
    if (challenge === undefined || !PKCE_PATTERN.test(challenge)) return fail('invalid_request');
    if (params['code_challenge_method'] !== 'S256') return fail('invalid_request');
    const resource = params['resource'] ?? mcpResource(false);
    if (resource !== mcpResource(false) && resource !== mcpResource(true)) {
      return fail('invalid_request');
    }

    const request = await (
      await getMcpAuthRequestRepository()
    ).create({
      clientId: client.id,
      clientName: client.name,
      redirectUri,
      state,
      codeChallenge: challenge,
      resource,
      requestedScopes: parseScopes(params['scope']),
      expiresAt: new Date(Date.now() + REQUEST_TTL_MS),
    });
    const lng = (params['ui_locales'] ?? '').trim().toLowerCase().startsWith('he') ? 'he' : 'en';
    return { redirectTo: consentPageUrl(request.id, lng) };
  }

  /** What the consent page shows this member. 404 `request_expired` when it can't be answered. */
  static async describe(id: string, userId: string): Promise<ConsentView> {
    const request = await loadPending(id);
    const mine = await Workspace.listFor(userId);
    const keys = await getAgentKeyRepository();
    const workspaces = await Promise.all(
      mine.map(async ({ workspace, role }): Promise<ConsentWorkspace> => {
        const allowed = allowedScopes(role, request.resource);
        return {
          id: workspace.id,
          name: workspace.name,
          role,
          allowed,
          preselected: request.requestedScopes.filter(
            (scope) => allowed.includes(scope) && !NEVER_PRESELECTED.includes(scope),
          ),
          atCap: (await keys.countForUser(workspace.id, userId)) >= LIMITS.agentKeysPerUser,
        };
      }),
    );
    return {
      clientName: request.clientName,
      redirectHost: new URL(request.redirectUri).host,
      readonly: isReadonly(request.resource),
      requested: request.requestedScopes,
      workspaces,
    };
  }

  /** The member's yes: one workspace, scopes their role permits, a name. Issues the code. */
  static async approve(
    id: string,
    actor: ActorRef,
    input: { workspaceId: string; scopes: AgentScope[]; name: string },
  ): Promise<{ redirectTo: string }> {
    const request = await loadPending(id);
    if (
      !Array.isArray(input.scopes) ||
      !input.scopes.every((scope) => typeof scope === 'string') ||
      typeof input.workspaceId !== 'string'
    ) {
      throw new AppError(400, 'The scopes must be a list of names');
    }
    const caller = await Caller.enter(input.workspaceId, actor);
    if (caller === null) throw new NotFoundError();

    const scopes = AGENT_SCOPES.filter((scope) => input.scopes.includes(scope));
    if (scopes.length === 0) throw new AppError(400, 'Choose at least one permission');
    const allowed = allowedScopes(caller.role.name, request.resource);
    if (input.scopes.some((scope) => !allowed.includes(scope))) {
      throw new AppError(400, 'This role cannot grant some of these scopes', {
        code: 'scope_not_allowed',
      });
    }
    const name = typeof input.name === 'string' ? input.name.trim() : '';
    if (name === '' || name.length > NAME_MAX) {
      throw new AppError(400, `The name must be 1 to ${String(NAME_MAX)} characters`);
    }
    const keys = await getAgentKeyRepository();
    if ((await keys.countForUser(caller.workspaceId, caller.userId)) >= LIMITS.agentKeysPerUser) {
      throw new AppError(
        409,
        `You can hold at most ${String(LIMITS.agentKeysPerUser)} agents here: revoke one first`,
        { code: 'agent_key_cap' },
      );
    }

    const code = CODE_PREFIX + randomBytes(32).toString('base64url');
    const now = new Date();
    const approved = await (
      await getMcpAuthRequestRepository()
    ).approve(
      id,
      {
        userId: caller.userId,
        workspaceId: caller.workspaceId,
        scopes,
        name,
        codeHash: sha256Hex(code),
        expiresAt: new Date(now.getTime() + CODE_TTL_MS),
      },
      now,
    );
    if (approved === null) throw expired();
    return redirectWith(approved.redirectUri, approved.state, { code });
  }

  /** The member's no: back to the client with `access_denied`. */
  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- any signed-in member may refuse
  static async deny(id: string, _userId: string): Promise<{ redirectTo: string }> {
    const request = await loadPending(id);
    if (!(await (await getMcpAuthRequestRepository()).deny(id))) throw expired();
    return redirectWith(request.redirectUri, request.state, { error: 'access_denied' });
  }

  /**
   * The token endpoint's `authorization_code` grant. Every failure is `invalid_grant` and says
   * nothing of which check failed. `now` is for tests.
   */
  static async exchange(
    input: ExchangeInput,
    now: Date = new Date(),
    origin: ActorOrigin = {},
  ): Promise<IssuedTokens> {
    if (!input.code.startsWith(CODE_PREFIX)) throw invalidGrant();
    const requests = await getMcpAuthRequestRepository();
    const request = await requests.findByCodeHash(sha256Hex(input.code));
    if (request === null) throw invalidGrant();
    if (request.clientId !== input.clientId || request.redirectUri !== input.redirectUri) {
      throw invalidGrant();
    }
    if (request.status === 'used') {
      // Shown a second time: it leaked. End what the first use made.
      await AgentKey.revokeBySource(request.id);
      throw invalidGrant();
    }
    if (request.status !== 'approved' || request.expiresAt.getTime() <= now.getTime()) {
      throw invalidGrant();
    }
    if (!PKCE_PATTERN.test(input.codeVerifier)) throw invalidGrant();
    if (pkceChallenge(input.codeVerifier) !== request.codeChallenge) throw invalidGrant();
    if (input.resource !== undefined && input.resource !== request.resource) throw invalidGrant();
    if (request.userId === null || request.workspaceId === null || request.name === null) {
      throw invalidGrant();
    }
    // Still a member? The grant would be dead on arrival otherwise.
    const caller = await Caller.enter(request.workspaceId, Actor.user(request.userId));
    if (caller === null) throw invalidGrant();
    // The role may have dropped since the member approved.
    const allowed = allowedScopes(caller.role.name, request.resource);
    if (request.scopes.some((scope) => !allowed.includes(scope))) throw invalidGrant();
    // The cap holds at sign-in, not only at consent (codes approved earlier count only now).
    const keys = await getAgentKeyRepository();
    if ((await keys.countForUser(request.workspaceId, request.userId)) >= LIMITS.agentKeysPerUser) {
      throw new OAuthError('access_denied', 'The agent limit is reached');
    }

    if (!(await requests.markUsed(request.id, 'approved'))) {
      // Lost the race to another exchange of the same code.
      await AgentKey.revokeBySource(request.id);
      throw invalidGrant();
    }
    return AgentKey.issueGrant(
      {
        workspaceId: request.workspaceId,
        userId: request.userId,
        name: request.name,
        scopes: request.scopes,
        clientId: request.clientId,
        clientName: request.clientName,
        resource: request.resource,
        sourceRequestId: request.id,
      },
      Actor.user(request.userId, origin),
      now,
    );
  }
}
