import jwt from 'jsonwebtoken';
import jwksClient from 'jwks-rsa';
import { environment } from '../config/environment.js';
import { assertUnderTest } from '../config/testSwitches.js';

let client: jwksClient.JwksClient | null = null;

function getClient(): jwksClient.JwksClient {
  client ??= jwksClient({
    jwksUri: `${environment.cognitoIssuer}/.well-known/jwks.json`,
    cache: true,
    cacheMaxAge: 600000,
    cacheMaxEntries: 5,
  });

  return client;
}

function getKey(header: jwt.JwtHeader, callback: jwt.SigningKeyCallback): void {
  getClient().getSigningKey(header.kid, (err: Error | null, key?: jwksClient.SigningKey) => {
    if (err !== null) {
      callback(err);
      return;
    }
    const signingKey = key?.getPublicKey();
    callback(null, signingKey);
  });
}

export type TokenVerifier = (token: string) => Promise<jwt.JwtPayload>;

let verifierForTests: TokenVerifier | null = null;

/**
 * Tests only (node:test): verifies tokens with `verifier` instead of Cognito (testing/testAuth.ts
 * mints and verifies them); null restores Cognito. It throws in a server, so a running API only
 * ever accepts Cognito's tokens.
 */
export function setTokenVerifierForTests(verifier: TokenVerifier | null): void {
  assertUnderTest('setTokenVerifierForTests');
  verifierForTests = verifier;
}

/** Verifies a Cognito ID token: RS256, signed by the user pool's JWKS, issuer and audience checked. */
export async function verifyToken(token: string): Promise<jwt.JwtPayload> {
  if (verifierForTests !== null) return await verifierForTests(token);
  // Anything but RS256 is refused before a signing key is fetched (jwt.verify fetches it first).
  if (jwt.decode(token, { complete: true })?.header.alg !== 'RS256') {
    throw new jwt.JsonWebTokenError('invalid algorithm');
  }
  return new Promise((resolve, reject) => {
    jwt.verify(
      token,
      getKey,
      {
        issuer: environment.cognitoIssuer,
        audience: environment.cognitoClientId,
        algorithms: ['RS256'],
      },
      (err, decoded) => {
        if (err !== null) {
          reject(err);
        } else {
          resolve(decoded as jwt.JwtPayload);
        }
      },
    );
  });
}
