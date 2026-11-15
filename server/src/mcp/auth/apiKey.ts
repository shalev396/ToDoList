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
 * The one 401 every failed check gets. `resource` is the endpoint's (mcpResource): the challenge
 * points an OAuth client to that resource's metadata (RFC 9728), so it can sign in.
 */
export function sendUnauthorized(
  res: Response,
  presented: boolean,
  body: unknown,
  resource: string,
): void {
  const metadata = `${mcpIssuer()}/resource-metadata${resource === mcpResource(true) ? '/readonly' : ''}`;
  const challenge =
    `Bearer realm="${REALM}", resource_metadata="${metadata}", scope="${SUGGESTED_SCOPE}"` +
    (presented ? ', error="invalid_token"' : '');
  res
    .status(401)
    .set('WWW-Authenticate', challenge)
    .json(
      jsonRpcError(
        requestIdOf(body),
        JSON_RPC.unauthorized,
        'Unauthorized: send a valid agent key as a Bearer token',
      ),
    );
}

/**
 * Counts one failed authentication: true when it is within the limit (the limiter passed it on),
 * false when the limiter answered 429 itself.
 */
function withinFailureLimit(
  failures: RequestHandler,
  req: Request,
  res: Response,
): Promise<boolean> {
  return new Promise((resolve, reject) => {
    const done = failures(req, res, (error?: unknown) => {
      if (error === undefined) resolve(true);
      else reject(error instanceof Error ? error : new Error('The failed-auth limiter failed'));
    });
    Promise.resolve(done).then(() => {
      resolve(false);
    }, reject);
  });
}

/**
 * Express middleware: authenticates the agent key or grant token for this endpoint (`resourceOf`),
 * or answers 401. `failures` (the per-address failed-authentication limiter) is consulted only
 * when the key fails, so it counts failures alone and never stands in the way of a key that
 * authenticates; over its limit, it answers 429 itself.
 */
export function createMcpAuth(
  failures: RequestHandler,
  resourceOf: (req: Request) => string,
): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const { presented, key } = bearerKey(req.headers.authorization);
    const resource = resourceOf(req);
    const agent =
      key === null ? null : await authenticateAgentKey(key, new Date(), Actor.originOf(req));
    // A sign-in grant is for one endpoint (its token audience); a key (resource null) is for both.
    if (agent !== null && (agent.resource === null || agent.resource === resource)) {
      setRequestAgent(res, agent);
      next();
      return;
    }
    if (await withinFailureLimit(failures, req, res)) {
      sendUnauthorized(res, presented, req.body, resource);
    }
  };
}
