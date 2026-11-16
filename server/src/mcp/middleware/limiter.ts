/**
 * Rate limits for MCP (MCP.md §3: per-agent limits stand in for a WAF the HTTP API can't have).
 * Over a limit the answer is a JSON-RPC error, so an MCP client reads it like any other error.
 *
 * - agentLimiter: requests per presented agent key (or sign-in access token), across /api/mcp and
 *   /api/mcp/readonly. It runs before mcpAuth and is keyed by the credential itself (its SHA-256),
 *   so agents behind one egress address (a hosted assistant) don't share a budget, and a key over
 *   its budget is refused without a database lookup. A request with no well-formed credential
 *   is not counted here: mcpAuth refuses it without a lookup. A sign-in grant's access token
 *   changes on every refresh (rotateGrant replaces the key hash), so its per-key budget restarts
 *   on each refresh; the bound is API Gateway's MCP route throttle. Personal keys keep one budget.
 * - AuthFailureLimit: failed authentications per client address. mcpAuth spends it only when a
 *   well-formed key was looked up and is unknown (an expired or revoked one exists: 401, no
 *   spend), so it never holds off a key that authenticates (hosted assistants share egress addresses). Over the
 *   budget, a failed key gets 429 instead of 401, still with the `WWW-Authenticate` challenge, so
 *   a client stuck on a bad key backs off (Retry-After) and can still start sign-in. It neither
 *   saves the lookup nor refuses a right guess: guessing is bounded by the 256-bit keys and API
 *   Gateway's MCP route throttle.
 *
 * Counters are in memory, per Lambda instance, like the other limiters (middlewares/rateLimit.ts),
 * and always on (only a test, config/testSwitches.ts, or the local server's `--no-rate-limits`,
 * config/localSwitches.ts, turns them off).
 */
import type { Request, Response } from 'express';
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';

import { environment } from '../../config/environment.js';
import { sha256Hex } from '../../services/crypto/hashing.js';
import { addressKey } from '../../utils/clientAddress.js';
import { bearerKey } from '../auth/apiKey.js';
import { jsonRpcError, JSON_RPC, requestIdOf } from '../jsonRpc.js';

export interface Limit {
  max: number;
  windowMs: number;
}

/** 120 requests a minute per agent key: a busy agent session, not a scraper. */
export const AGENT_LIMIT: Limit = { max: 120, windowMs: 60_000 };

/** 50 failed authentications per address in 15 minutes. */
export const AUTH_FAILURE_LIMIT: Limit = { max: 50, windowMs: 15 * 60_000 };

function limiter(
  limit: Limit,
  message: string,
  keyGenerator: NonNullable<Options['keyGenerator']>,
  skip: (req: Request) => boolean = () => false,
): RateLimitRequestHandler {
  return rateLimit({
    windowMs: limit.windowMs,
    limit: limit.max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    handler: (req: Request, res) => {
      res.status(429).json(jsonRpcError(requestIdOf(req.body), JSON_RPC.rateLimited, message));
    },
    skip: (req: Request) => !environment.rateLimitEnabled || skip(req),
  });
}

/** The agent key or access token a request presents, by its SHA-256; null when it presents none. */
function presentedCredential(req: Request): string | null {
  const { key } = bearerKey(req.headers.authorization);
  return key === null ? null : sha256Hex(key);
}

/** The credential a request presents (never the raw key); the address when there is none. */
export function agentKey(req: Request): string {
  const credential = presentedCredential(req);
  return credential === null ? `ip:${addressKey(req.ip)}` : `key:${credential}`;
}

/** Mounted before mcpAuth: a request without a well-formed credential is not counted here. */
export function agentLimiter(limit: Limit = AGENT_LIMIT): RateLimitRequestHandler {
  return limiter(
    limit,
    'Too many requests for this agent key. Wait a minute and try again.',
    agentKey,
    (req) => presentedCredential(req) === null,
  );
}

/** What mcpAuth asks of a failed-authentication budget (AuthFailureLimit is the real one). */
export interface AuthFailureBudget {
  /**
   * Counts one failed authentication: true within the budget, false when it answered 429 itself.
   * mcpAuth calls it only after a well-formed key was looked up and is unknown, so a key that
   * authenticates never spends it, and neither does a request with no well-formed key.
   */
  spend(req: Request, res: Response): Promise<boolean>;
}

/** Failed authentications per client address (an IPv6 address by its /56). */
export class AuthFailureLimit implements AuthFailureBudget {
  readonly #counter: RateLimitRequestHandler;

  constructor(limit: Limit = AUTH_FAILURE_LIMIT) {
    this.#counter = limiter(
      limit,
      'Too many failed authentications from this address. Try again later.',
      (req) => addressKey(req.ip),
    );
  }

  spend(req: Request, res: Response): Promise<boolean> {
    return new Promise((resolve, reject) => {
      const done = this.#counter(req, res, (error?: unknown) => {
        if (error === undefined) resolve(true);
        else reject(error instanceof Error ? error : new Error('The failed-auth limiter failed'));
      });
      // The limiter's promise settles after it either passed the request on (resolved above)
      // or answered 429 itself.
      Promise.resolve(done).then(() => {
        resolve(false);
      }, reject);
    });
  }
}
