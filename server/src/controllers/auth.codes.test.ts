/**
 * The Cognito auth handlers answer with a generic message and a machine code (types/errorCodes.ts)
 * instead of Cognito's own text, which can quote the input. Cognito is replaced by a stub that
 * throws the named exception; no AWS call is made.
 */
import { afterEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, RequestHandler, Response } from 'express';

// config/environment.ts reads process.env at import: a deployed-like stage with Cognito auth.
Object.assign(process.env, {
  ENV: 'dev',
  AWS_REGION: 'us-east-1',
  COGNITO_CLIENT_ID: 'test-client',
  COGNITO_USER_POOL_ID: 'us-east-1_test',
  DATABASE_URL: 'mongodb://127.0.0.1:1/unused',
  DOMAIN_NAME: 'example.test',
});

const { CognitoIdentityProviderClient } = await import('@aws-sdk/client-cognito-identity-provider');
const { AuthController } = await import('./auth.js');

const EMAIL = 'someone@example.test';

interface Reply {
  status: number | undefined;
  message: string;
  code: string | undefined;
}

afterEach(() => {
  mock.restoreAll();
});

/** Runs a handler with Cognito throwing `exceptionName`; returns what it answered. */
async function reply(
  handler: RequestHandler,
  body: unknown,
  exceptionName: string,
): Promise<Reply> {
  mock.method(CognitoIdentityProviderClient.prototype, 'send', () => {
    const error = new Error(`Cognito says: bad input for ${EMAIL}`);
    error.name = exceptionName;
    return Promise.reject(error);
  });
  mock.method(console, 'error', () => undefined);
  let answer: Reply | undefined;
  const res = {
    error: (message: string, status?: number, code?: string): void => {
      answer = { status, message, code };
    },
    success: (): void => {
      throw new Error('unexpected success');
    },
  };
  await handler({ body } as Request, res as unknown as Response, () => undefined);
  assert.ok(answer, 'the handler answered with an error');
  return answer;
}

function assertGeneric(answer: Reply): void {
  assert.equal(answer.message.includes(EMAIL), false, 'echoes the email');
  assert.equal(answer.message.includes('Cognito says'), false, 'echoes Cognito');
}

describe('login', () => {
  it('UserNotConfirmedException → 403 email_unverified', async () => {
    const answer = await reply(
      AuthController.login,
      { email: EMAIL, password: 'x' },
      'UserNotConfirmedException',
    );
    assert.equal(answer.status, 403);
    assert.equal(answer.code, 'email_unverified');
  });

  for (const exception of ['NotAuthorizedException', 'UserNotFoundException']) {
    it(`${exception} → 401 invalid_credentials`, async () => {
      const answer = await reply(AuthController.login, { email: EMAIL, password: 'x' }, exception);
      assert.equal(answer.status, 401);
      assert.equal(answer.code, 'invalid_credentials');
      assertGeneric(answer);
    });
  }
});

describe('signup', () => {
  const body = { email: EMAIL, password: 'x', name: 'Someone' };

  it('UsernameExistsException → user_exists', async () => {
    const answer = await reply(AuthController.signup, body, 'UsernameExistsException');
    assert.equal(answer.code, 'user_exists');
    assertGeneric(answer);
  });

  it('InvalidPasswordException → password_policy', async () => {
    const answer = await reply(AuthController.signup, body, 'InvalidPasswordException');
    assert.equal(answer.code, 'password_policy');
    assertGeneric(answer);
  });

  it('anything else → a generic message without a code', async () => {
    const answer = await reply(AuthController.signup, body, 'SomethingUnexpected');
    assert.equal(answer.code, undefined);
    assertGeneric(answer);
  });
});

describe('confirm sign-up', () => {
  const body = { email: EMAIL, code: '123456' };

  it('CodeMismatchException → code_invalid', async () => {
    const answer = await reply(AuthController.confirmSignup, body, 'CodeMismatchException');
    assert.equal(answer.code, 'code_invalid');
    assertGeneric(answer);
  });

  it('ExpiredCodeException → code_expired', async () => {
    const answer = await reply(AuthController.confirmSignup, body, 'ExpiredCodeException');
    assert.equal(answer.code, 'code_expired');
    assertGeneric(answer);
  });

  it('anything else → a generic message', async () => {
    assertGeneric(await reply(AuthController.confirmSignup, body, 'SomethingUnexpected'));
  });
});

describe('reset password', () => {
  const body = { email: EMAIL, code: '123456', password: 'x' };

  for (const [exception, code] of [
    ['CodeMismatchException', 'code_invalid'],
    ['ExpiredCodeException', 'code_expired'],
    ['InvalidPasswordException', 'password_policy'],
  ] as const) {
    it(`${exception} → ${code}`, async () => {
      const answer = await reply(AuthController.resetPassword, body, exception);
      assert.equal(answer.status, 400);
      assert.equal(answer.code, code);
      assertGeneric(answer);
    });
  }
});
