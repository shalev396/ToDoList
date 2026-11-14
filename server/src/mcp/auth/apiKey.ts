/**
 * Agent-key authentication (MCP.md §4 option A, DATA.md §3.14). Agents send
 * `Authorization: Bearer elk_…`; the key is hashed with SHA-256 and looked up by its hash, the
 * only form ever stored. A missing, malformed, unknown, expired or revoked key, or one whose user
 * is no longer an active member, gets the same 401: `WWW-Authenticate: Bearer` and a generic
 * JSON-RPC error that never says which check failed.
 */
import type { Request, RequestHandler, Response } from 'express';

import { Actor, type ActorOrigin } from '../../classes/base/Actor.js';
import { getAgentKeyRepository, type AgentKeyData } from '../../models/index.js';
import { hashAgentKey } from '../../services/agentKeys.js';
import { jsonRpcError, JSON_RPC, requestIdOf } from '../jsonRpc.js';
import { resolvePrincipal, setRequestAgent, type AuthenticatedAgent } from './principal.js';

/** `elk_` + 32 random bytes in base64url: the only shape of a key. */
const AGENT_KEY_PATTERN = /^elk_[A-Za-z0-9_-]{43}$/;

/** A use is written to `lastUsedAt` at most once a minute per key, not on every call. */
const TOUCH_INTERVAL_MS = 60_000;

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
    key: candidate !== undefined && AGENT_KEY_PATTERN.test(candidate) ? candidate : null,
  };
}

function isUsable(key: AgentKeyData, now: Date): boolean {
  if (key.revokedAt !== null) return false;
  return key.expiresAt === null || key.expiresAt.getTime() > now.getTime();
}

/**
 * The agent behind a raw key, or null when the key is malformed, unknown, revoked or expired, or
 * its user is no longer an active member of the key's workspace. Records the use (`lastUsedAt`).
 * `origin`: the request's address and user agent, for the audit log.
 */
export async function authenticateAgentKey(
  rawKey: string,
  now: Date = new Date(),
  origin: ActorOrigin = {},
): Promise<AuthenticatedAgent | null> {
  if (!AGENT_KEY_PATTERN.test(rawKey)) return null;
  const keys = await getAgentKeyRepository();
  const key = await keys.findByHash(hashAgentKey(rawKey));
  if (key === null || !isUsable(key, now)) return null;
  const agent = await resolvePrincipal(key, origin);
  if (agent === null) return null;
  const lastUsed = key.lastUsedAt?.getTime() ?? null;
  if (lastUsed === null || now.getTime() - lastUsed >= TOUCH_INTERVAL_MS) {
    await keys.touch(key.workspaceId, key.id, now);
  }
  return agent;
}

/** The one 401 every failed check gets. */
export function sendUnauthorized(res: Response, presented: boolean, body: unknown): void {
  const challenge = presented
    ? `Bearer realm="${REALM}", error="invalid_token"`
    : `Bearer realm="${REALM}"`;
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
 * Express middleware: authenticates the agent key, or answers 401. `failures` (the per-address
 * failed-authentication limiter) is consulted only when the key fails, so it counts failures alone
 * and never stands in the way of a key that authenticates; over its limit, it answers 429 itself.
 */
export function createMcpAuth(failures: RequestHandler): RequestHandler {
  return async (req, res, next): Promise<void> => {
    const { presented, key } = bearerKey(req.headers.authorization);
    const agent =
      key === null ? null : await authenticateAgentKey(key, new Date(), Actor.originOf(req));
    if (agent !== null) {
      setRequestAgent(res, agent);
      next();
      return;
    }
    if (await withinFailureLimit(failures, req, res)) sendUnauthorized(res, presented, req.body);
  };
}
