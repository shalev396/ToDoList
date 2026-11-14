/** Account handlers never put a 5xx error's own text on the wire; only known 4xx messages pass. */
import { afterEach, beforeEach, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, RequestHandler, Response } from 'express';

Object.assign(process.env, {
  ENV: 'dev',
  AWS_REGION: 'us-east-1',
  COGNITO_CLIENT_ID: 'test-client',
  COGNITO_USER_POOL_ID: 'us-east-1_test',
  DATABASE_URL: 'mongodb://127.0.0.1:1/unused',
  DOMAIN_NAME: 'example.test',
});

const { User } = await import('../classes/index.js');
const { AccountController } = await import('./account.js');
const { StagedUploadError } = await import('../services/stagedUpload.js');

const { Media } = await import('../classes/index.js');

const LEAK = 'connect ECONNREFUSED 10.0.0.7:27017 FAKE-secret-detail';

beforeEach(() => {
  mock.method(Media, 'findByUploadedBy', () => Promise.resolve([]));
  mock.method(Media, 'deleteByUploadedBy', () => Promise.resolve());
});

afterEach(() => {
  mock.restoreAll();
});

async function reply(
  handler: RequestHandler,
  body: unknown = {},
): Promise<{ status: number | undefined; message: string }> {
  mock.method(console, 'error', () => undefined);
  let answer: { status: number | undefined; message: string } | undefined;
  const res = {
    error: (message: string, status?: number): void => {
      answer = { status, message };
    },
    success: (): void => {
      throw new Error('unexpected success');
    },
  };
  const req = { body, user: { id: 'u1', cognitoSub: 'sub' } } as unknown as Request;
  await handler(req, res as unknown as Response, () => undefined);
  assert.ok(answer, 'the handler answered with an error');
  return answer;
}

describe('account 5xx answers are generic', () => {
  const handlers: [string, RequestHandler][] = [
    ['getMe', AccountController.getMe],
    ['updateMe', AccountController.updateMe],
    ['exportMyData', AccountController.exportMyData],
    ['sendTestEmail', AccountController.sendTest],
  ];
  for (const [name, handler] of handlers) {
    it(`${name} hides the error message`, async () => {
      mock.method(User, 'findById', () => Promise.reject(new Error(LEAK)));
      const answer = await reply(handler, { name: 'x' });
      assert.equal(answer.status, 500);
      assert.equal(answer.message, 'Internal server error');
    });
  }

  it('deleteAccount hides the error message', async () => {
    mock.method(User, 'deleteAccount', () => Promise.reject(new Error(LEAK)));
    const answer = await reply(AccountController.deleteAccount);
    assert.equal(answer.status, 500);
    assert.equal(answer.message, 'Internal server error');
  });

  it('deleteAccount still answers 404 for a missing user', async () => {
    mock.method(User, 'deleteAccount', () => Promise.reject(new Error('User not found')));
    const answer = await reply(AccountController.deleteAccount);
    assert.equal(answer.status, 404);
    assert.equal(answer.message, 'User not found');
  });

  it('updateMe keeps a staged-upload 4xx message', async () => {
    mock.method(User, 'findById', () => Promise.reject(new StagedUploadError(413, 'Too large')));
    const answer = await reply(AccountController.updateMe, { name: 'x' });
    assert.equal(answer.status, 413);
    assert.equal(answer.message, 'Too large');
  });
});
