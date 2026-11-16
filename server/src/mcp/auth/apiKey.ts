/**
 * Agent-key authentication (MCP.md §4 option A, DATA.md §3.14). Agents send
 * `Authorization: Bearer elk_…` (a key) or `Bearer elo_…` (a sign-in grant's access token); the
 * token is hashed with SHA-256 and looked up by its hash, the only form ever stored. A missing,
 * malformed, unknown, expired or revoked token, or one whose user
 * is no longer an active member, gets the same 401: `WWW-Authenticate: Bearer` and a generic
 * JSON-RPC error that never says which check failed.
 */
import type { Request, RequestHandler, Response } from 'express';

import { AGENT_BEARER_PATTERN, AgentKey } from '../../classes/AgentKey.js';
import { Actor, type ActorOrigin } from '../../classes/base/Actor.js';
import { jsonRpcError, JSON_RPC, requestIdOf } from '../jsonRpc.js';
import type { AuthFailureBudget } from '../middleware/limiter.js';
import { mcpIssuer, mcpResource } from '../oauth/urls.js';
import { setRequestAgent, type AuthenticatedAgent } from './principal.js';

const REALM = 'todolist-mcp';

/**
 * The key in an Authorization header. `presented` says whether the client sent credentials at all
 * (it decides the `WWW-Authenticate` error attribute); `key` is null unless they are exactly
 * `Bearer elk_…`.
 */
export function bearerKey(authorization: string | undefined): {
  presented: boolean;
  key: string | null;
} {
  const header = authorization?.trim() ?? '';
  if (header === '') return { presented: false, key: null };
  const candidate = /^Bearer\s+(\S+)$/i.exec(header)?.[1];
  return {
    presented: true,
    key: candidate !== undefined && AGENT_BEARER_PATTERN.test(candidate) ? candidate : null,
  };
}

/** The agent behind a raw key or access token, or null (AgentKey.authenticate has the rules). */
export function authenticateAgentKey(
  rawKey: string,
  now: Date = new Date(),
  origin: ActorOrigin = {},
): Promise<AuthenticatedAgent | null> {
  return AgentKey.authenticate(rawKey, now, origin);
}

/** What a client is told to ask for when it has no token yet (the sign-in's default scopes). */
const SUGGESTED_SCOPE = 'read items:write builder:write';

/**
 * The `WWW-Authenticate` challenge for this endpoint (`resource`, from mcpResource): it points an
 * OAuth client to that resource's metadata (RFC 9728), so it can sign in. `presented` (credentials
 * were sent) adds `error="invalid_token"`.
 */
function challengeFor(presented: boolean, resource: string): string {
  const metadata = `${mcpIssuer()}/resource-metadata${resource === mcpResource(true) ? '/readonly' : ''}`;
  return (
    `Bearer realm="${REALM}", resource_metadata="${metadata}", scope="${SUGGESTED_SCOPE}"` +
    (presented ? ', error="invalid_token"' : '')
  );
}

/** The one 401 every failed check gets, with the challenge. */
export function sendUnauthorized(
  res: Response,
  presented: boolean,
  body: unknown,
  resource: string,
): void {
  res
    .status(401)
    .set('WWW-Authenticate', challengeFor(presented, resource))
    .json(
      jsonRpcError(
        requestIdOf(body),
        JSON_RPC.unauthorized,
        'Unauthorized: send a valid agent key as a Bearer token',
      ),
    );
}

/**
 * Express middleware: authenticates the agent key or grant token for this endpoint (`resourceOf`),
 * or answers 401. Without a well-formed key nothing is looked up and nothing is spent: the 401
 * challenge is how a client finds sign-in. `failures` (the per-address failed-authentication
 * budget) is spent only after a well-formed key is looked up and fails, so it never stands in the
 * way of a key that authenticates, whatever its address's count; over its budget it answers 429
 * itself, still with the challenge, so a client can refresh or sign in once it has waited.
 */
export function createMcpAuth(
  failures: AuthFailureBudget,
  resourceOf: (req: Request) => string,
): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const { presented, key } = bearerKey(req.headers.authorization);
    const resource = resourceOf(req);
    if (key === null) {
      sendUnauthorized(res, presented, req.body, resource);
      return;
    }
    const agent = await authenticateAgentKey(key, new Date(), Actor.originOf(req));
    // A sign-in grant is for one endpoint (its token audience); a key (resource null) is for both.
    if (agent !== null && (agent.resource === null || agent.resource === resource)) {
      setRequestAgent(res, agent);
      next();
      return;
    }
    res.set('WWW-Authenticate', challengeFor(true, resource));
    if (await failures.spend(req, res)) {
      sendUnauthorized(res, true, req.body, resource);
    }
  };
}
