/** The OAuth push applies ops as Code.gs's applyOps_ does, against a scripted writer. */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { CalendarApiError, type CalendarWriter, type WrittenEvent } from './calendarApi.js';
import type { EventBody, WireOp } from './diff.js';
import { applyOps } from './oauthCalendar.js';

const event = (id: string): EventBody => ({
  id,
  summary: 'Item',
  description: '',
  start: { date: '2026-11-20' },
  end: { date: '2026-11-21' },
  status: 'confirmed',
  extendedProperties: { private: { origin: 'todolist', todolistItemId: 'i', todolistWs: 'w' } },
});
const written = (id: string): WrittenEvent => ({
  id,
  etag: '"2"',
  updated: '2026-11-13T10:00:00Z',
});

/** A writer whose calls answer from `script` (an error status or success), recording each call. */
function scripted(script: Record<string, number>): CalendarWriter & { calls: string[] } {
  const calls: string[] = [];
  const answer = (call: string, id: string): Promise<WrittenEvent> => {
    calls.push(call);
    const status = script[call];
    return status === undefined
      ? Promise.resolve(written(id))
      : Promise.reject(new CalendarApiError(status));
  };
  return {
    calls,
    insert: (_calendar, body) => answer(`insert ${body.id}`, body.id),
    patch: (_calendar, id, _body, etag) =>
      answer(`patch ${id}${etag === undefined ? '' : ` if ${etag}`}`, id),
    remove: async (_calendar, id): Promise<void> => {
      await answer(`remove ${id}`, id).catch((error: unknown) => {
        if (error instanceof CalendarApiError && (error.status === 404 || error.status === 410))
          return;
        throw error;
      });
    },
  };
}

const op = (type: WireOp['type'], id: string, etag?: string): WireOp => ({
  opId: `${type}.${id}.0123456789abcdef`,
  type,
  calendarId: 'me@example.test',
  eventId: id,
  ...(etag === undefined ? {} : { etag }),
  ...(type === 'delete' ? {} : { event: event(id) }),
});

describe('applyOps (OAuth push)', () => {
  it('a create whose id exists is patched; an update carries If-Match; a gone delete is done', async () => {
    const writer = scripted({ 'insert elaaa': 409, 'remove elccc': 410 });
    const results = await applyOps(
      writer,
      [op('create', 'elaaa'), op('update', 'elbbb', '"1"'), op('delete', 'elccc')],
      Date.now() + 60_000,
    );
    assert.deepEqual(writer.calls, [
      'insert elaaa',
      'patch elaaa',
      'patch elbbb if "1"',
      'remove elccc',
    ]);
    assert.deepEqual(
      results.map((result) => [result.ok, result.eventId ?? null, result.etag ?? null]),
      [
        [true, 'elaaa', '"2"'],
        [true, 'elbbb', '"2"'],
        [true, null, null],
      ],
    );
  });

  it('412 is a conflict, 429 rate_limited, anything else an error; the run goes on', async () => {
    const writer = scripted({
      'patch elaaa if "1"': 412,
      'insert elbbb': 429,
      'insert elccc': 500,
    });
    const results = await applyOps(
      writer,
      [
        op('update', 'elaaa', '"1"'),
        op('create', 'elbbb'),
        op('create', 'elccc'),
        op('create', 'elddd'),
      ],
      Date.now() + 60_000,
    );
    assert.deepEqual(
      results.map((result) => result.code ?? 'ok'),
      ['conflict', 'rate_limited', 'error', 'ok'],
    );
  });

  it('ops past the deadline are deferred, not sent', async () => {
    const writer = scripted({});
    let clock = 0;
    const results = await applyOps(
      writer,
      [op('create', 'elaaa'), op('create', 'elbbb')],
      1,
      () => (clock += 1),
    );
    assert.deepEqual(
      results.map((result) => result.code ?? 'ok'),
      ['ok', 'deferred'],
    );
    assert.deepEqual(writer.calls, ['insert elaaa']);
  });
});
