/**
 * verifyToken: Cognito's RS256 tokens only, unless a test installed its own verifier, which only
 * node:test can do. A token signed any other way is refused before a signing key is fetched.
 */
import { afterEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import jwt from 'jsonwebtoken';

import { mintTestToken, testSubForEmail, verifyTestToken } from '../testing/testAuth.js';
import { installOutboundGuard } from '../testing/outboundGuard.js';

Object.assign(process.env, {
  ENV: 'dev',
  AWS_REGION: 'us-east-1',
  COGNITO_CLIENT_ID: 'test-client',
  COGNITO_USER_POOL_ID: 'us-east-1_test',
});

const { setTokenVerifierForTests, verifyToken } = await import('./cognitoUtil.js');

const EMAIL = 'someone@example.test';
const testToken = (): string =>
  mintTestToken({ sub: testSubForEmail(EMAIL), email: EMAIL, name: 'someone' });

afterEach(() => {
  setTokenVerifierForTests(null);
});

describe('verifyToken', () => {
  it('refuses a test token when no test verifier is installed, without fetching a key', async () => {
    const guard = installOutboundGuard();
    try {
      await assert.rejects(verifyToken(testToken()), /invalid algorithm/);
      const unsigned = jwt.sign({ sub: 'x' }, '', { algorithm: 'none' });
      await assert.rejects(verifyToken(unsigned), /invalid algorithm/);
      await assert.rejects(verifyToken('not-a-token'), /invalid algorithm/);
      assert.deepEqual(guard.externalHosts(), []);
    } finally {
      guard.restore();
    }
  });

  it("accepts a test token only through the test's own verifier", async () => {
    setTokenVerifierForTests(verifyTestToken);
    const claims = await verifyToken(testToken());
    assert.equal(claims['email'], EMAIL);
    assert.equal(claims.sub, testSubForEmail(EMAIL));
    setTokenVerifierForTests(null);
    await assert.rejects(verifyToken(testToken()), /invalid algorithm/);
  });

  it('the test verifier still refuses a tampered or foreign token', async () => {
    setTokenVerifierForTests(verifyTestToken);
    const [header, , signature] = testToken().split('.');
    const forged = Buffer.from(JSON.stringify({ sub: 'other', email: 'x@example.test' }));
    await assert.rejects(
      verifyToken(`${header ?? ''}.${forged.toString('base64url')}.${signature ?? ''}`),
    );
    const foreign = jwt.sign({ sub: 'x', email: EMAIL, token_use: 'id' }, 'another-key-FAKE', {
      algorithm: 'HS256',
    });
    await assert.rejects(verifyToken(foreign));
  });
});
