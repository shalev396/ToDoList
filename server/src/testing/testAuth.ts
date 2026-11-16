/**
 * Test-only sign-in. Tests mint their own ID tokens: HS256 JWTs shaped like Cognito's (sub, email,
 * name, token_use), signed with a constant FAKE key, and the verifier testSeams.ts installs with
 * setTokenVerifierForTests accepts them. A running server has no way to accept one: that setter
 * throws outside node:test, and verifyToken otherwise takes Cognito's RS256 tokens only.
 *
 * No imports from the app, so a test can import it before the environment is set up.
 */
import { createHash } from 'node:crypto';
import jwt from 'jsonwebtoken';

const SECRET = 'todolist-test-token-key-FAKE-0123456789abcdef';
const ISSUER = 'todolist-tests';
const AUDIENCE = 'todolist-tests';
const ID_TOKEN_SECONDS = 3600;
/** RFC 4122 namespace for the deterministic test subjects (UUID v5). */
const SUBJECT_NAMESPACE = '6f1c4f5e-2a0b-4b8e-9d3f-7c2e1a9b5d40';

export interface TestIdentity {
  sub: string;
  email: string;
  name: string;
}

/** A stable UUID v5 per email address (case-insensitive): the test user's Cognito `sub`. */
export function testSubForEmail(email: string): string {
  const namespace = Buffer.from(SUBJECT_NAMESPACE.replace(/-/g, ''), 'hex');
  const hash = createHash('sha1').update(namespace).update(email.trim().toLowerCase()).digest();
  const bytes = hash.subarray(0, 16);
  bytes[6] = ((bytes[6] ?? 0) & 0x0f) | 0x50;
  bytes[8] = ((bytes[8] ?? 0) & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

/** The name a user has before they pick one: the part of the email before the @. */
export function defaultNameFor(email: string): string {
  return email.split('@')[0] ?? email;
}

/** An ID token for `identity`, valid for an hour. */
export function mintTestToken(identity: TestIdentity): string {
  return jwt.sign({ ...identity, token_use: 'id' }, SECRET, {
    algorithm: 'HS256',
    issuer: ISSUER,
    audience: AUDIENCE,
    expiresIn: ID_TOKEN_SECONDS,
  });
}

/**
 * Checks signature, issuer, audience, expiry and token_use, like jwt.verify does for Cognito's.
 * Rejects on any mismatch.
 */
export function verifyTestToken(token: string): Promise<jwt.JwtPayload> {
  try {
    const decoded = jwt.verify(token, SECRET, {
      algorithms: ['HS256'],
      issuer: ISSUER,
      audience: AUDIENCE,
    });
    if (typeof decoded === 'string') throw new Error('Invalid test token');
    if (decoded['token_use'] !== 'id') throw new Error('Expected an id token');
    if (typeof decoded.sub !== 'string' || typeof decoded['email'] !== 'string') {
      throw new Error('Invalid test token: missing subject or email');
    }
    return Promise.resolve(decoded);
  } catch (error) {
    return Promise.reject(error instanceof Error ? error : new Error('Invalid test token'));
  }
}
