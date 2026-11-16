import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { z } from 'zod';

import { AppError } from '../errors/AppError.js';
import { issueText, parseOr400, safeSegment } from './validation.js';

const Body = z.strictObject({
  name: z.string().trim().min(1),
  settings: z.strictObject({ weekStart: z.enum(['sun', 'mon']) }).optional(),
});

function badRequest(message: RegExp): (error: unknown) => boolean {
  return (error: unknown) =>
    error instanceof AppError && error.statusCode === 400 && message.test(error.message);
}

describe('parseOr400', () => {
  it('returns the parsed data', () => {
    assert.deepEqual(parseOr400(Body, { name: ' Workspace ' }), { name: 'Workspace' });
  });

  it('answers 400 naming the first problem and where it is', () => {
    assert.throws(() => parseOr400(Body, { name: '' }), badRequest(/^name: /));
    assert.throws(
      () => parseOr400(Body, { name: 'Workspace', settings: { weekStart: 'tue' } }),
      badRequest(/^settings\.weekStart: /),
    );
    assert.throws(
      () => parseOr400(Body, { name: 'Workspace', extra: 1 }),
      badRequest(/^Unrecognized key$/),
    );
    assert.throws(() => parseOr400(Body, null), badRequest(/expected object/));
  });

  it('never echoes the rejected value', () => {
    const secretLooking = 'value-that-must-not-come-back';
    assert.throws(
      () => parseOr400(Body, { name: 'Workspace', settings: { weekStart: secretLooking } }),
      (error: unknown) => error instanceof AppError && !error.message.includes(secretLooking),
    );
  });

  it('never echoes a key the client sent, in the message or in a path', () => {
    const pastedKey = 'key-that-must-not-come-back-0123456789abcdef';
    for (const body of [
      { name: 'Workspace', [pastedKey]: 1 },
      { name: 'Workspace', settings: { [pastedKey]: 1 } },
    ]) {
      assert.throws(
        () => parseOr400(Body, body),
        (error: unknown) => error instanceof AppError && !error.message.includes(pastedKey),
      );
    }
    const Open = z.strictObject({ labels: z.record(z.string(), z.number()) });
    assert.throws(
      () => parseOr400(Open, { labels: { [pastedKey]: 'not a number' } }),
      (error: unknown) => error instanceof AppError && !error.message.includes(pastedKey),
    );
  });
});

function firstIssue(result: { error?: z.ZodError }): z.ZodError['issues'][number] {
  const issue = result.error?.issues[0];
  assert.ok(issue, 'a failed parse');
  return issue;
}

describe('issueText and safeSegment', () => {
  const numbers = z.record(z.string(), z.number());
  const token = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';

  it('replaces a long or secret-shaped path segment', () => {
    const long = 'k'.repeat(41);
    assert.equal(issueText(firstIssue(numbers.safeParse({ [long]: 'x' }))).includes(long), false);
    assert.equal(issueText(firstIssue(numbers.safeParse({ [token]: 'x' }))).includes(token), false);
  });

  it('answers a fixed message for an unrecognized key', () => {
    const Inner = z.object({ inner: z.strictObject({ a: z.string() }) });
    const issue = firstIssue(Inner.safeParse({ inner: { a: 'x', [token]: 1 } }));
    assert.equal(issueText(issue), 'inner: Unrecognized key');
  });

  it('keeps ordinary field names', () => {
    assert.equal(safeSegment('weekStart'), 'weekStart');
    assert.equal(safeSegment(3), '3');
  });
});
