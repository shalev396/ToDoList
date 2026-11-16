import type { Request, Response } from 'express';
import rateLimit, { type Options, type RateLimitRequestHandler } from 'express-rate-limit';
import { environment } from '../config/environment.js';
import { verifiedCognitoSub } from './expressAuth.js';

const WINDOW_MS = 15 * 60 * 1000; // 15 minutes

type KeyGenerator = NonNullable<Options['keyGenerator']>;

/** The client's address: what an unauthenticated request is counted by. */
export function ipKey(req: Request): string {
  return `ip:${req.ip ?? 'unknown'}`;
}

/**
 * The verified Cognito user (verifyCognitoToken's `sub`) of an authenticated request, so people
 * behind one address (an office, a campus, a mobile carrier) don't share a budget; the address
 * when no token was verified.
 */
export function userKey(req: Request, res: Response): string {
  const sub = verifiedCognitoSub(res);
  return sub === undefined ? ipKey(req) : `user:${sub}`;
}

/**
 * `max` requests per 15 minutes per key (by default the client's address), counted per limiter
 * instance.
 *
 * Every API surface gets its own instance (its own in-memory counter): one Lambda serves them
 * all, and a shared counter would add public, private and dev traffic into a single budget.
 *
 * Always on; only a test turns them off (config/testSwitches.ts).
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
 * Authenticated user APIs (/api/private), per user: app.ts mounts it after the token is verified
 * and before the user is loaded, so an over-budget user is refused without a database read.
 */
export const privateLimiter = limiter(200, userKey);

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
