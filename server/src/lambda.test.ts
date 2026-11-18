/**
 * lambda.ts, the only function's entry: a background sync job (`sync-run`, `gcal-run`, sent by
 * the function to itself) runs through the worker and throws when a retry may help; a malformed
 * job is dropped with 400 (never retried); a maintenance action answers `{statusCode, body}`; an
 * API Gateway event is HTTP, whatever other keys it carries.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Context } from 'aws-lambda';

import { forceSyncModeForTests } from './config/testSwitches.js';
import type * as Models from './models/index.js';
import { registerAdapter } from './sync/registry.js';
import { createFakeAdapter, FAKE_PROVIDER } from './testing/fakeAdapter.js';
import { installOutboundGuard, type OutboundGuard } from './testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from './testing/testDatabase.js';

forceSyncModeForTests('fixtures');

type Handler = (event: unknown, context: Context) => Promise<unknown>;

let db: TestDatabase;
let guard: OutboundGuard;
let models: typeof Models;
let handler: Handler;
let workspaceId: string;
const context = {} as Context;

before(async () => {
  db = await startTestDatabase('todolist_lambda_test');
  guard = installOutboundGuard();
  registerAdapter(createFakeAdapter().adapter);
  models = await import('./models/index.js');
  workspaceId = (
    await (
      await models.getWorkspaceRepository()
    ).create({ name: 'Lambda', slug: 'lambda', ownerId: 'u-owner' })
  ).id;
  ({ handler } = await import('./lambda.js'));
});

after(async () => {
  guard.restore();
  await db.stop();
});

/** A fake integration and a queued run of it, as enqueueSync leaves them. */
async function queuedRun(accountId: string): Promise<{ integrationId: string; runId: string }> {
  const integration = await (
    await models.getIntegrationRepository()
  ).create(workspaceId, {
    connectedBy: 'u-owner',
    provider: FAKE_PROVIDER,
    accountId,
    label: 'Fake',
    authMethod: 'none',
    topicId: 'work',
  });
  const run = await (
    await models.getSyncRunRepository()
  ).create(workspaceId, { integrationId: integration.id, trigger: 'manual', status: 'queued' });
  return { integrationId: integration.id, runId: run.id };
}

const ok = { statusCode: 200, body: '{"ok":true}' };

describe('lambda handler: background sync jobs', () => {
  it('runs a sync-run job: the queued run it names', async () => {
    const { integrationId, runId } = await queuedRun('lambda-1');
    const event = { action: 'sync-run', integrationId, runId, mode: 'fixtures' };
    assert.deepEqual(await handler(event, context), ok);
    const run = await (await models.getSyncRunRepository()).findById(workspaceId, runId);
    assert.deepEqual([run?.status, run?.counts['inserted']], ['partial', 4]);
  });

  it('runs a gcal-run job; an integration that is not eligible is skipped, not retried', async () => {
    assert.deepEqual(await handler({ action: 'gcal-run', integrationId: 'gone' }, context), ok);
  });

  it('throws when a retry may help, so that Lambda runs the job again', async (t) => {
    const integrations = await models.getIntegrationRepository();
    t.mock.method(integrations, 'findByIdForWorker', () =>
      Promise.reject(new Error('database unreachable')),
    );
    await assert.rejects(handler({ action: 'gcal-run', integrationId: 'any' }, context), {
      name: 'RetrySyncJob',
    });
  });

  it('drops a malformed job with 400: never retried', async () => {
    for (const event of [
      { action: 'sync-run', integrationId: 'i-1' },
      { action: 'sync-run', integrationId: 'i-1', runId: 'r-1', mode: 'turbo' },
      { action: 'gcal-run' },
    ]) {
      assert.deepEqual(await handler(event, context), {
        statusCode: 400,
        body: '{"error":"Malformed job"}',
      });
    }
  });
});

describe('lambda handler: maintenance actions', () => {
  it('answers an action with its status code and result', async () => {
    const result = (await handler({ action: 'purge' }, context)) as {
      statusCode: number;
      body: string;
    };
    assert.equal(result.statusCode, 200);
    assert.equal((JSON.parse(result.body) as { timedOutRuns: unknown }).timedOutRuns, 0);
  });
});

describe('lambda handler: scheduled tick', () => {
  it('runs the scheduled tick on sync-dispatch', async () => {
    const result = (await handler({ action: 'sync-dispatch' }, context)) as {
      statusCode: number;
      body: string;
    };
    assert.equal(result.statusCode, 200);
    const body = JSON.parse(result.body) as { dispatch: { dispatched: unknown }; passes: unknown };
    assert.equal(typeof body.dispatch.dispatched, 'number');
    // The travel pass ran, with no member to regenerate.
    assert.deepEqual(body.passes, { 'travel-pass': { done: 0, left: 0 } });
  });
});

describe('lambda handler: HTTP', () => {
  it('serves an API Gateway event through Express, even one that carries job keys', async () => {
    const path = '/api/public/no-such-route';
    const event = {
      version: '2.0',
      routeKey: '$default',
      rawPath: path,
      rawQueryString: '',
      headers: { host: 'localhost' },
      isBase64Encoded: false,
      requestContext: {
        http: { method: 'GET', path, protocol: 'HTTP/1.1', sourceIp: '127.0.0.1', userAgent: 't' },
        requestId: 'request-1',
        routeKey: '$default',
        stage: '$default',
        timeEpoch: 0,
      },
      // A job's keys on an HTTP event: HTTP traffic can never start a job.
      action: 'sync-run',
      integrationId: 'i-1',
      runId: 'r-1',
      mode: 'live',
    };
    const result = (await handler(event, context)) as { statusCode: number };
    assert.equal(result.statusCode, 404);
  });

  it('never opened a connection outside this machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
