import type { Request } from 'express';
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import { environment } from '../config/environment.js';
import { sha256Hex } from '../services/crypto/hashing.js';
import { addressKey } from '../utils/clientAddress.js';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

type KeyGenerator = NonNullable<Options['keyGenerator']>;

/**
 * The client's address: what an unauthenticated request is counted by. An IPv6 address counts by
 * its /56 (utils/clientAddress.ts), so cycling through one's own prefix gets no fresh budget.
 */
export function ipKey(req: Request): string {
  return `ip:${addressKey(req.ip)}`;
}

/**
 * The bearer token a request presents, by its SHA-256, so people behind one address (an office, a
 * campus, a mobile carrier) don't share a budget, and the raw token is never kept. The token is
 * not verified yet: the limiter runs before verification so a request over its budget costs
 * neither a verification nor a database read. A request with no bearer token counts by address.
 */
export function tokenKey(req: Request): string {
  const header = req.headers.authorization;
  const token = header?.startsWith('Bearer ') === true ? header.substring(7) : '';
  return token === '' ? ipKey(req) : `token:${sha256Hex(token)}`;
}

/**
 * `max` requests per 15 minutes per key (by default the client's address), counted per limiter
 * instance.
 *
 * Every API surface gets its own instance (its own in-memory counter): one Lambda serves them
 * all, and a shared counter would add public, private and dev traffic into a single budget.
 *
 * Always on; only a test (config/testSwitches.ts) or the local server's `--no-rate-limits`
 * (config/localSwitches.ts) turns them off, never a Lambda.
 */
export function limiter(max: number, keyGenerator: KeyGenerator = ipKey): RateLimitRequestHandler {
  return rateLimit({
    windowMs: WINDOW_MS,
    max,
    standardHeaders: true,
    legacyHeaders: false,
    keyGenerator,
    // The API's error envelope, instead of the library's plain-text default.
    message: { message: 'Too many requests. Please try again later.' },
    skip: () => !environment.rateLimitEnabled,
  });
}

/**
 * Authenticated user APIs (/api/private), per presented token: app.ts mounts it first, before the
 * token is verified, so an over-budget caller is refused without verification or a database read.
 */
export const privateLimiter = limiter(200, tokenKey);

/**
 * Auth endpoints (/api/public/auth: login, signup, forgot-password, …), per address: nobody is
 * signed in yet. These hit Cognito/SES and are the primary abuse target — keep tight.
 */
export const authLimiter = limiter(100);

/** MCP sign-in's client registration (/api/mcp/oauth/register): public, so per address and tight. */
export const mcpOAuthLimiter = limiter(30);

/**
 * MCP sign-in's token and revoke endpoints, per address: the client is not authenticated until
 * the handler checks it, and a key it merely names could spend somebody else's budget. Hosted
 * agents (Claude.ai) call them from the vendor's server addresses, so many members share one IP:
 * a generous budget, apart from register's.
 */
export const mcpTokenLimiter = limiter(600);

/** OAuth callbacks (/api/public/oauth), per address: a browser lands there once per connection. */
export const oauthLimiter = limiter(60);

/**
 * MCP sign-in's discovery documents (routes/mcpOAuth.ts: authorization-server and protected-resource
 * metadata, the empty key set), per address. Static and public, and hosted agents fetch them from
 * shared vendor addresses on every sign-in and refresh: generous.
 */
export const discoveryLimiter = limiter(1000);
