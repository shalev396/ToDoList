/**
 * The Calendar API writer's allow-list: exactly calendars.insert, events.insert, events.patch and
 * events.delete under the calendar base, by method, with no query but an event patch's or
 * delete's `sendUpdates=all|none`. The URL must be exactly as sent: a dot segment (`.`, `..`,
 * `%2e%2e`) or an empty one, which the URL parser would fold into a calendar's own endpoint, is
 * refused, as is anything else (a calendar's delete or ACL, a GET, another host, a malformed id),
 * before anything is sent.
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
  it('allows exactly the four writes, each with its method, and sendUpdates on a patch or delete', () => {
    for (const [method, url] of [
      ['POST', `${BASE}/calendars`],
      ['POST', `${BASE}/calendars/${CAL}/events`],
      ['PATCH', `${BASE}/calendars/${CAL}/events/h5abc123`],
      ['DELETE', `${BASE}/calendars/${CAL}/events/h5abc123`],
      ['PATCH', `${BASE}/calendars/${CAL}/events/h5abc123?sendUpdates=all`],
      ['DELETE', `${BASE}/calendars/${CAL}/events/h5abc123?sendUpdates=none`],
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
      // sendUpdates only as all or none, only on a patch or delete, never with anything else.
      ['PATCH', `${BASE}/calendars/${CAL}/events/h5abc123?sendUpdates=externalOnly`],
      ['DELETE', `${BASE}/calendars/${CAL}/events/h5abc123?sendUpdates=all&x=1`],
      ['POST', `${BASE}/calendars/${CAL}/events?sendUpdates=all`],
      ['POST', `${BASE}/calendars?sendUpdates=none`],
      ['DELETE', `${BASE}/calendars/${CAL}?sendUpdates=all`],
    ] as const) {
      assert.equal(isAllowedCalendarWrite(method, url), false, `${method} ${url}`);
    }
  });

  it('refuses a dot or empty segment, encoded or not: an event call never lands on a calendar', () => {
    for (const [method, url] of [
      // `events/..` and `events/%2e%2e` would be sent as DELETE /calendars/{id}/: the calendar.
      ['DELETE', `${BASE}/calendars/abc%40group.calendar.google.com/events/..`],
      ['DELETE', `${BASE}/calendars/x/events/%2e%2e`],
      ['DELETE', `${BASE}/calendars/x/events/%2E%2E`],
      ['PATCH', `${BASE}/calendars/x/events/.`],
      ['PATCH', `${BASE}/calendars/x/events/%2e`],
      // A calendar id of `..` would land on /calendar/v3/events/x.
      ['DELETE', `${BASE}/calendars/../events/x`],
      ['POST', `${BASE}/calendars/%2e%2e/events`],
      ['POST', `${BASE}/calendars/./events`],
      // Empty segments, a bad escape, a backslash the parser turns into a slash.
      ['DELETE', `${BASE}/calendars//events/x`],
      ['DELETE', `${BASE}/calendars/x//events/y`],
      ['DELETE', `${BASE}/calendars/x/events/%E0%A4%A`],
      ['DELETE', `${BASE}/calendars/x/events/a\\..`],
      ['DELETE', `${BASE}/calendars/x/events\\..`],
      ['DELETE', `${BASE}/calendars/x/events/y#frag`],
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
    await assert.rejects(writer.remove('me@example.test', '..'), refused);
    await assert.rejects(writer.remove('..', 'h5abc123'), refused);
    await assert.rejects(writer.remove('.', 'h5abc123', 'all'), refused);
    await assert.rejects(writer.update('me@example.test', '', { summary: 'x' }), refused);
    await assert.rejects(writer.update('x', '..', { summary: 'x' }, 'none'), refused);
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
