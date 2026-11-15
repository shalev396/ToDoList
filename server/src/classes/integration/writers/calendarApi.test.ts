/**
 * The Calendar API writer's allow-list: exactly calendars.insert, events.insert, events.patch and
 * events.delete under the calendar base, by method, with no query. Anything else (a calendar's
 * delete or ACL, a GET, another host, a malformed id) is refused before anything is sent.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  CalendarWriteRefusedError,
  calendarWriter,
  isAllowedCalendarWrite,
} from './calendarApi.js';

const BASE = 'https://www.googleapis.com/calendar/v3';
const CAL = encodeURIComponent('me@example.test');

describe('isAllowedCalendarWrite', () => {
  it('allows exactly the four writes, each with its method', () => {
    for (const [method, url] of [
      ['POST', `${BASE}/calendars`],
      ['POST', `${BASE}/calendars/${CAL}/events`],
      ['PATCH', `${BASE}/calendars/${CAL}/events/h5abc123`],
      ['DELETE', `${BASE}/calendars/${CAL}/events/h5abc123`],
    ] as const) {
      assert.equal(isAllowedCalendarWrite(method, url), true, `${method} ${url}`);
    }
  });

  it('refuses everything else', () => {
    for (const [method, url] of [
      // A calendar's own delete, edit, clear, ACL; the calendar list.
      ['DELETE', `${BASE}/calendars/${CAL}`],
      ['PATCH', `${BASE}/calendars/${CAL}`],
      ['POST', `${BASE}/calendars/${CAL}/clear`],
      ['POST', `${BASE}/calendars/${CAL}/acl`],
      ['DELETE', `${BASE}/calendars/${CAL}/acl/user:x`],
      ['POST', `${BASE}/users/me/calendarList`],
      // Other event calls: move, import, quick add, watch, instances.
      ['POST', `${BASE}/calendars/${CAL}/events/h5abc123/move`],
      ['POST', `${BASE}/calendars/${CAL}/events/import`],
      ['POST', `${BASE}/calendars/${CAL}/events/quickAdd`],
      ['POST', `${BASE}/calendars/${CAL}/events/watch`],
      // Wrong method, a query, empty ids, another host.
      ['PUT', `${BASE}/calendars/${CAL}/events/h5abc123`],
      ['GET', `${BASE}/calendars/${CAL}/events`],
      ['PATCH', `${BASE}/calendars/${CAL}/events`],
      ['DELETE', `${BASE}/calendars`],
      ['POST', `${BASE}/calendars/${CAL}/events?sendUpdates=all`],
      ['POST', `${BASE}/calendars?x=1`],
      ['DELETE', `${BASE}/calendars/${CAL}/events/`],
      ['POST', `${BASE}/calendars//events`],
      ['POST', 'https://evil.example/calendar/v3/calendars'],
      ['POST', `${BASE}.evil.example/calendars`],
    ] as const) {
      assert.equal(isAllowedCalendarWrite(method, url), false, `${method} ${url}`);
    }
  });
});

describe('calendarWriter', () => {
  const realFetch = globalThis.fetch;
  const sent: string[] = [];

  before(() => {
    globalThis.fetch = (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
      sent.push(
        `${init?.method ?? 'GET'} ${input instanceof Request ? input.url : input.toString()}`,
      );
      return Promise.reject(new Error('nothing may be sent'));
    };
  });

  after(() => {
    globalThis.fetch = realFetch;
  });

  it('a malformed id never reaches the network: the allow-list refuses the path first', async () => {
    const writer = calendarWriter({ authorization: 'Bearer FAKE-access' });
    const refused = (error: unknown): boolean => error instanceof CalendarWriteRefusedError;
    await assert.rejects(writer.remove('me@example.test', ''), refused);
    await assert.rejects(writer.update('me@example.test', '', { summary: 'x' }), refused);
    await assert.rejects(
      writer.insert('', {
        id: 'h5abc',
        summary: 'x',
        description: '',
        start: { date: '2026-11-20' },
        end: { date: '2026-11-21' },
        status: 'confirmed',
      }),
      refused,
    );
    assert.deepEqual(sent, []);
  });
});
