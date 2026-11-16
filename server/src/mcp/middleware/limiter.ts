/**
 * Rate limits for MCP (MCP.md §3: per-agent limits stand in for a WAF the HTTP API can't have).
 * Over a limit the answer is a JSON-RPC error, so an MCP client reads it like any other error.
 *
 * - agentLimiter: requests per agent key (or sign-in grant), across /api/mcp and
 *   /api/mcp/readonly. Keyed by the authenticated key's id, so agents behind one egress address
 *   (a hosted assistant) don't share a budget; by the address only if no agent was authenticated.
 * - AuthFailureLimit: failed authentications per client address. mcpAuth spends it only when a
 *   key fails, after the lookup, so it counts nothing else and never holds off a key that
 *   authenticates: hosted assistants share egress addresses, and an expired grant counts as a
 *   failure, so a busy shared address must not lock out every member's valid key. Over the budget,
 *   a failed key gets 429 instead of 401; that keeps key guessing from turning into a query flood.
 *
 * Counters are in memory, per Lambda instance, like the other limiters (middlewares/rateLimit.ts),
 * and always on (only a test, config/testSwitches.ts, or the local server's `--no-rate-limits`,
 * config/localSwitches.ts, turns them off).
 */
import { isIPv6 } from 'node:net';
import type { Request, Response } from 'express';
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';

import { environment } from '../../config/environment.js';
import { findRequestAgent } from '../auth/principal.js';
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
    skip: () => !environment.rateLimitEnabled,
  });
}

/** The agent key (or grant) mcpAuth authenticated; the address when there is none. */
export function agentKey(req: Request, res: Response): string {
  const agent = findRequestAgent(res);
  return agent === undefined ? `ip:${addressKey(req.ip)}` : `agent:${agent.principal.agentId}`;
}

export function agentLimiter(limit: Limit = AGENT_LIMIT): RateLimitRequestHandler {
  return limiter(
    limit,
    'Too many requests for this agent key. Wait a minute and try again.',
    agentKey,
  );
}

/** The eight 16-bit groups of an IPv6 address, or null when it isn't one. */
function ipv6Groups(address: string): number[] | null {
  const withoutZone = address.split('%')[0] ?? '';
  if (!isIPv6(withoutZone)) return null;
  // An embedded IPv4 tail (64:ff9b::192.0.2.1) is the last two groups.
  const text = withoutZone.replace(
    /(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/,
    (_match, a: string, b: string, c: string, d: string) =>
      `${((Number(a) << 8) | Number(b)).toString(16)}:${((Number(c) << 8) | Number(d)).toString(16)}`,
  );
  const [head = '', tail] = text.split('::');
  const groups = (part: string): number[] =>
    part === '' ? [] : part.split(':').map((group) => parseInt(group, 16));
  const left = groups(head);
  const right = tail === undefined ? [] : groups(tail);
  const zeros: number[] = new Array<number>(8 - left.length - right.length).fill(0);
  return [...left, ...zeros, ...right];
}

/**
 * The address a failed authentication counts against: an IPv4 address as it is (an IPv4-mapped
 * IPv6 address as its IPv4 address); an IPv6 address by its /56 prefix, one customer's usual
 * allocation, so cycling through addresses in it doesn't reset the count.
 */
export function addressKey(ip: string | undefined): string {
  if (ip === undefined || ip === '') return 'unknown';
  const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/i.exec(ip);
  if (mapped?.[1] !== undefined) return mapped[1];
  const groups = ipv6Groups(ip);
  if (groups === null) return ip;
  const [a = 0, b = 0, c = 0, d = 0] = groups;
  return `${[a, b, c, d & 0xff00].map((group) => group.toString(16)).join(':')}::/56`;
}

/** What mcpAuth asks of a failed-authentication budget (AuthFailureLimit is the real one). */
export interface AuthFailureBudget {
  /**
   * Counts one failed authentication: true within the budget, false when it answered 429 itself.
   * mcpAuth calls it only after a key failed, so a key that authenticates never spends it.
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
