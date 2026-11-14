/**
 * Test-only Google service account, for the google_calendar adapter tests.
 *
 * - fakeServiceAccount(): an RSA key pair generated in memory, once per test process. It is never
 *   written to disk or the repo, so no real-looking key is ever committed; the client email is
 *   fake (example.invalid).
 * - FAKE_UNUSABLE_PEM: a private key marked FAKE (the repo's secret scanner accepts it). OpenSSL
 *   cannot read it, so it exercises the "key cannot sign" path and the redaction checks.
 * - decodeJwt(): decodes a compact JWT and checks its RS256 signature against the public key.
 */
import { createVerify, generateKeyPairSync } from 'node:crypto';

export const FAKE_CLIENT_EMAIL = 'fake-sync@fake-project.iam.example.invalid';

/** Marked FAKE: the scanner ignores it, and it signs nothing. */
export const FAKE_UNUSABLE_PEM = [
  '-----BEGIN FAKE PRIVATE KEY-----',
  'FAKEbm90LWEta2V5LWp1c3QtYS1GQUtFLW1hcmtlcg0KFAKEFAKEFAKEFAKEFAKEFAKE',
  '-----END FAKE PRIVATE KEY-----',
].join('\n');

export interface FakeServiceAccount {
  /** The vault's secret for a `service_account` integration (DATA.md §3.5). */
  secret: { clientEmail: string; privateKey: string };
  /** Verifies what the adapters sign. */
  publicKey: string;
}

let generated: FakeServiceAccount | null = null;

export function fakeServiceAccount(): FakeServiceAccount {
  if (generated === null) {
    const { privateKey, publicKey } = generateKeyPairSync('rsa', {
      modulusLength: 2048,
      publicKeyEncoding: { type: 'spki', format: 'pem' },
      privateKeyEncoding: { type: 'pkcs8', format: 'pem' },
    });
    generated = { secret: { clientEmail: FAKE_CLIENT_EMAIL, privateKey }, publicKey };
  }
  return generated;
}

export interface DecodedJwt {
  header: Record<string, unknown>;
  claims: Record<string, unknown>;
  /** The RS256 signature matches the public key. */
  verified: boolean;
}

function decodePart(part: string | undefined): Record<string, unknown> {
  return JSON.parse(Buffer.from(part ?? '', 'base64url').toString('utf8')) as Record<
    string,
    unknown
  >;
}

export function decodeJwt(token: string, publicKey: string): DecodedJwt {
  const [header, claims, signature] = token.split('.');
  const verifier = createVerify('RSA-SHA256');
  verifier.update(`${header ?? ''}.${claims ?? ''}`);
  return {
    header: decodePart(header),
    claims: decodePart(claims),
    verified: verifier.verify(publicKey, Buffer.from(signature ?? '', 'base64url')),
  };
}
