/**
 * The hashes the server shares, one implementation each so every caller hashes the same way:
 * - `sha256Hex`: SHA-256 of UTF-8 text, in hex. Random tokens are stored only as this hash
 *   (agent keys, invite links, connect links, OAuth states), and argument fingerprints use it.
 *   A random token needs no slow hash: it can't be guessed, only looked up. Scanners flag this
 *   as a weak password hash; why it's safe is in docs/security/CODE-SCANNING.md.
 * - `pkceChallenge`: RFC 7636 S256, BASE64URL(SHA256(ASCII(code_verifier))).
 */
import { createHash } from 'node:crypto';

export function sha256Hex(value: string): string {
  return createHash('sha256').update(value, 'utf8').digest('hex');
}

export function pkceChallenge(verifier: string): string {
  return createHash('sha256').update(verifier, 'ascii').digest('base64url');
}
