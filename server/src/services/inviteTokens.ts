/**
 * Invite link tokens (DATA.md §3.3): 32 random bytes, base64url. The raw token travels once, in
 * the invite link; only its SHA-256 (hex) is stored, so the database alone can't accept invites.
 */
import { randomBytes } from 'node:crypto';

import { sha256Hex } from './crypto/hashing.js';
import { findSecrets } from './secretPatterns.js';

export const INVITE_TOKEN_BYTES = 32;
/** What a raw token looks like: anything else can't be one, so it is "not found" unhashed. */
export const INVITE_TOKEN_PATTERN = /^[A-Za-z0-9_-]{43}$/;

const MAX_DRAWS = 10;

export function hashInviteToken(rawToken: string): string {
  return sha256Hex(rawToken);
}

/**
 * A fresh raw token. Very rarely, random base64url reads as a provider token to the response
 * guard (a `pk_…` run, say), which would block the one response that carries the invite link; such
 * a draw is discarded. `random` is injectable for tests.
 */
export function newInviteToken(
  random: () => Buffer = () => randomBytes(INVITE_TOKEN_BYTES),
): string {
  for (let draw = 0; draw < MAX_DRAWS; draw += 1) {
    const token = random().toString('base64url');
    if (findSecrets(token).length === 0) return token;
  }
  throw new Error('Could not draw an invite token');
}
