import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { redact } from './logger.js';

describe('redact', () => {
  it('masks values under sensitive keys at any depth', () => {
    const out = redact({
      headers: { Authorization: 'anything', cookie: 'c=1', 'x-api-key': 'k' },
      body: { password: 'p', nested: [{ clientSecret: 's', title: 'kept' }] },
      sessionToken: 't',
    });
    assert.deepEqual(out, {
      headers: { Authorization: '[REDACTED]', cookie: '[REDACTED]', 'x-api-key': '[REDACTED]' },
      body: { password: '[REDACTED]', nested: [{ clientSecret: '[REDACTED]', title: 'kept' }] },
      sessionToken: '[REDACTED]',
    });
  });

  it('masks secret-shaped values inside free text', () => {
    const out = redact('provider said: bad token ghp_FAKEabcdefghijklmnopqrstuvwxyz0123') as string;
    assert.equal(out.includes('ghp_FAKE'), false);
    assert.match(out, /REDACTED:github_token/);
  });

  it('turns errors into plain objects with redacted messages and stacks', () => {
    const error = new Error('connect failed for mongodb://u:FAKE-pw@db.example.com/x');
    const out = redact(error) as { name: string; message: string; stack?: string };
    assert.equal(out.name, 'Error');
    assert.equal(out.message.includes('FAKE-pw'), false);
    assert.equal((out.stack ?? '').includes('FAKE-pw'), false);
  });

  it('survives cycles and leaves ordinary values alone', () => {
    const node: Record<string, unknown> = { a: 1, when: new Date(0) };
    node['self'] = node;
    const out = redact(node) as Record<string, unknown>;
    assert.equal(out['a'], 1);
    assert.equal(out['self'], '[Circular]');
  });
});

describe('installConsoleRedaction', () => {
  const token = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';

  function capture(stream: 'stderr' | 'stdout', fn: () => void): string {
    const target = process[stream];
    const original = target.write.bind(target);
    let out = '';
    target.write = (chunk: string | Uint8Array): boolean => {
      out += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
      return true;
    };
    try {
      fn();
    } finally {
      target.write = original;
    }
    return out;
  }

  it('redacts debug, trace and dir as well as log/info/warn/error', async () => {
    const { installConsoleRedaction } = await import('./logger.js');
    installConsoleRedaction();
    const sink: Console = console;
    for (const method of ['log', 'info', 'warn', 'error', 'debug', 'trace'] as const) {
      const out = capture('stderr', () => {
        sink[method](`leak ${token}`);
      });
      assert.equal(out.includes(token), false, `${method} leaked`);
      assert.match(out, /REDACTED:github_token/, `${method} not redacted`);
    }
    const dirOut = capture('stdout', () => {
      sink.dir({ note: `leak ${token}` });
    });
    assert.equal(dirOut.includes(token), false);
    assert.match(dirOut, /REDACTED:github_token/);
  });
});
