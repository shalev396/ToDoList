/**
 * The sensitiveBody marker (DATA.md §7: the credential route's body is excluded from logs and
 * error handlers): the body leaves req.body, the handler takes it once, and the error handler
 * answers a marked request with fixed text and logs no error text at all.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import type * as Harness from '../testing/guardHarness.js';

/** Stands in for a credential value (not token-shaped, so redaction alone would miss it). */
const VALUE = 'FAKE-plain-credential-value-0123456789';

let base: string;
let server: Server;
let captureStderr: typeof Harness.captureStderr;
const seen: { body: unknown; taken: unknown; again: unknown }[] = [];

before(async () => {
  process.env.ENV = 'dev';
  const express = (await import('express')).default;
  const { AppError } = await import('../errors/AppError.js');
  const { errorHandler, responseFormatter } = await import('./responseFormatter.js');
  const { sensitiveBody, takeSensitiveBody } = await import('./sensitiveBody.js');
  ({ captureStderr } = await import('../testing/guardHarness.js'));

  const app = express();
  app.use(responseFormatter, express.json());
  app.put('/marked/ok', sensitiveBody, (req, res) => {
    const body: unknown = req.body;
    seen.push({ body, taken: takeSensitiveBody(req), again: takeSensitiveBody(req) });
    res.status(204).end();
  });
  app.put('/marked/:status', sensitiveBody, (req) => {
    const status = Number(req.params['status']);
    if (status === 0) throw new Error(`boom ${VALUE}`);
    throw new AppError(status, `refused ${VALUE}`);
  });
  app.put('/plain/400', () => {
    throw new AppError(400, 'Plain message');
  });
  app.use(errorHandler);
  server = await new Promise<Server>((resolve) => {
    const listening = app.listen(0, '127.0.0.1', () => {
      resolve(listening);
    });
  });
  base = `http://127.0.0.1:${String((server.address() as AddressInfo).port)}`;
});

after(() => {
  server.close();
});

async function put(path: string): Promise<{ status: number; text: string; logs: string }> {
  let status = 0;
  let text = '';
  const logs = await captureStderr(async () => {
    const res = await fetch(`${base}${path}`, {
      method: 'PUT',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ token: VALUE }),
    });
    status = res.status;
    text = await res.text();
  });
  return { status, text, logs };
}

describe('sensitiveBody: the body leaves req.body', () => {
  it('the handler sees req.body as {}, and takes the body exactly once', async () => {
    const res = await put('/marked/ok');
    assert.equal(res.status, 204);
    assert.equal(res.text, '');
    assert.deepEqual(seen, [{ body: {}, taken: { token: VALUE }, again: undefined }]);
  });
});

describe('sensitiveBody: the error handler answers fixed text and logs no error text', () => {
  const fixed: [number, string][] = [
    [400, 'Invalid request body'],
    [403, 'Forbidden'],
    [404, 'Not found'],
    [409, 'Conflict'],
    [422, 'Request refused'],
  ];
  for (const [status, message] of fixed) {
    it(`a ${String(status)} AppError → ${String(status)} "${message}", whatever its own message`, async () => {
      const res = await put(`/marked/${String(status)}`);
      assert.equal(res.status, status);
      assert.deepEqual(JSON.parse(res.text), { message });
      assert.equal(res.logs, '', 'a refused request logs nothing');
    });
  }

  it('an unexpected error → 500, logged by name and status only (no message, no stack)', async () => {
    const res = await put('/marked/0');
    assert.equal(res.status, 500);
    assert.deepEqual(JSON.parse(res.text), { message: 'Internal server error' });
    assert.match(res.logs, /PUT \/marked\/0 failed/);
    assert.match(res.logs, /errorName: 'Error'/);
    assert.match(res.logs, /statusCode: 500/);
    for (const leak of [VALUE, 'boom', 'at ']) assert.ok(!res.logs.includes(leak), res.logs);
  });

  it('a 5xx AppError keeps its status, with the same minimal log line', async () => {
    const res = await put('/marked/503');
    assert.equal(res.status, 503);
    assert.deepEqual(JSON.parse(res.text), { message: 'Internal server error' });
    assert.match(res.logs, /errorName: 'AppError'/);
    assert.ok(!res.logs.includes(VALUE) && !res.logs.includes('refused'), res.logs);
  });

  it('an unmarked route is unchanged: an AppError’s own message still answers', async () => {
    const res = await put('/plain/400');
    assert.deepEqual([res.status, JSON.parse(res.text)], [400, { message: 'Plain message' }]);
  });
});
