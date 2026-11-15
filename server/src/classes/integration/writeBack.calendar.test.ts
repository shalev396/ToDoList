/**
 * Google Calendar's new writes (CalendarProvider: updateEvent and deleteEvent by item,
 * deleteLinkedEvent by link, createCalendar, and insertEvent with a recurrence), end to end against
 * the mock Google with a real OAuth grant:
 * - an event is reached only through an item of THIS integration, in this workspace, on a calendar
 *   it reads, or through its own CalendarLink on the push target: another integration's event,
 *   another workspace's, a raw event id or an unselected calendar is 404 with zero non-GET
 *   requests;
 * - while read-only each write is refused with zero non-GET requests; once read & write, each
 *   sends its one allow-listed call, is audited, and the event's item follows;
 * - an event with other guests needs `notifyGuests` (409 `event_has_guests` otherwise), sent as
 *   `sendUpdates`;
 * - a recurrence is checked by the strict RRULE parser before anything is sent;
 * - a grant from before `calendar.app.created` answers `scope_missing` to createCalendar.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type * as Models from '../../models/index.js';
import type { ItemData } from '../../models/definitions/Item.js';
import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';
import {
  pointAppAtMockGoogle,
  startMockGoogle,
  type MockGoogle,
  type MockGoogleAccount,
} from '../../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';
import { contextFor, hasCode, hasStatus } from '../../testing/workspaceFixtures.js';
import type { Caller } from '../base/Caller.js';
import type { GoogleCalendarIntegration, PlainEventBody } from './index.js';

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000088', email: 'alice.writes@example.test' };
const BOB = { sub: '100000000000000000099', email: 'bob.oldgrant@example.test' };
const TZ = 'Asia/Jerusalem';

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
let token: string;
let ownerId: string;
let wid: string;
let caller: Caller;
let alice: GoogleCalendarIntegration;

const W = (): string => `/api/private/workspaces/${wid}`;

/** What Google was sent that is not a read (a token exchange included). */
const writes = (): string[] =>
  mock
    .requests()
    .filter((request) => request.method !== 'GET')
    .map((request) => `${request.method} ${request.path}`);

/** The non-GET requests sent since `before`. */
const since = (before: readonly string[]): string[] => writes().slice(before.length);

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_write_back_calendar');
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../../models/index.js');
  token = (await api.login('gwb-owner@example.test')).token;
  ownerId = data((await api.call('GET', '/api/private/me', { token })).body)['id'] as string;
  wid = (
    await (
      await models.getWorkspaceRepository()
    ).create({
      name: 'Calendar writes',
      slug: `gwb-${randomUUID().slice(0, 8)}`,
      ownerId,
      settings: { timezone: TZ },
    })
  ).id;
  await (await models.getMembershipRepository()).create(wid, { userId: ownerId, role: 'owner' });
  const { Caller: CallerClass } = await import('../base/Caller.js');
  const { Actor } = await import('../base/Actor.js');
  caller = CallerClass.fromContext(await contextFor(wid, ownerId), Actor.user(ownerId));
  alice = await connect(ALICE);
});

after(async () => {
  await api.stop();
  await mock.close();
  guard.restore();
});

/** Google Calendar connected through the OAuth flow as `account`; its class instance. */
async function connect(account: MockGoogleAccount): Promise<GoogleCalendarIntegration> {
  mock.setAccount(account);
  const started = await fetch(`${api.baseUrl}${W()}/integrations/google-calendar/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });
  const cookie = /todolist_oauth=[A-Za-z0-9_-]{43}/.exec(
    started.headers.get('set-cookie') ?? '',
  )?.[0];
  assert.ok(cookie !== undefined);
  const { authorizeUrl } = ((await started.json()) as { data: { authorizeUrl: string } }).data;
  const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
  const landed = await fetch(authorized.headers.get('location') ?? '', {
    redirect: 'manual',
    headers: { cookie },
  });
  const connected = /connected=([0-9a-f-]{36})/.exec(landed.headers.get('location') ?? '');
  assert.ok(connected, landed.headers.get('location') ?? '');
  return load(connected[1] ?? '');
}

async function load(id: string): Promise<GoogleCalendarIntegration> {
  const { Integration, GoogleCalendarIntegration: Google } = await import('./index.js');
  const integration = await Integration.findOwn(caller, id);
  assert.ok(integration instanceof Google);
  return integration;
}

async function switchToReadWrite(
  integration: GoogleCalendarIntegration,
): Promise<GoogleCalendarIntegration> {
  const switched = await api.call('PATCH', `${W()}/integrations/${integration.id}`, {
    token,
    body: { mode: 'read_write' },
  });
  assert.equal(switched.status, 200, switched.text);
  return load(integration.id);
}

const event = (id: string, over: Partial<PlainEventBody> = {}): PlainEventBody => ({
  id,
  summary: 'Gym',
  description: '',
  start: { dateTime: '2026-11-23T05:00:00.000Z', timeZone: TZ },
  end: { dateTime: '2026-11-23T06:00:00.000Z', timeZone: TZ },
  status: 'confirmed',
  ...over,
});

/** The event's item here, as a sync of `calendarId` writes it (its source hash set). */
async function mirrorEvent(
  eventId: string,
  options: {
    integration?: GoogleCalendarIntegration;
    calendarId?: string;
    workspaceId?: string;
    props?: Record<string, unknown>;
  } = {},
): Promise<ItemData> {
  const integration = options.integration ?? alice;
  const calendarId = options.calendarId ?? ALICE.email;
  const workspaceId = options.workspaceId ?? wid;
  const items = await models.getItemRepository();
  const account = { provider: 'google_calendar' as const, accountId: integration.accountId };
  const externalId = `${calendarId}:${eventId}`;
  await items.bulkUpsert(workspaceId, [
    {
      integrationId: integration.id,
      kind: 'event',
      topicId: null,
      title: 'Dentist',
      status: 'open',
      statusRaw: 'confirmed',
      startAt: new Date('2026-11-24T07:00:00Z'),
      endAt: new Date('2026-11-24T07:30:00Z'),
      allDay: false,
      props: { calendarId, eventId, attendeesCount: 0, guestsCount: 0, ...options.props },
      source: {
        ...account,
        externalId,
        key: null,
        url: 'https://calendar.google.com/calendar/event?eid=x',
        updatedAtSource: null,
        etag: null,
        hash: 'h-synced',
      },
    },
  ]);
  const stored = await items.findBySource(
    workspaceId,
    { ...account, integrationId: integration.id },
    externalId,
  );
  assert.ok(stored !== null);
  return stored;
}

/** An event "in Google" on Alice's primary calendar, and its item here. */
async function pulled(
  summary: string,
  props: Record<string, unknown> = {},
): Promise<{ eventId: string; item: ItemData }> {
  const added = mock.addEvent(ALICE.email, {
    summary,
    start: { dateTime: '2026-11-24T07:00:00Z' },
    end: { dateTime: '2026-11-24T07:30:00Z' },
  });
  return { eventId: added.id, item: await mirrorEvent(added.id, { props }) };
}

const eventPath = (eventId: string): string =>
  `/calendar/v3/calendars/${encodeURIComponent(ALICE.email)}/events/${eventId}`;

/** The query of the last request to `path`. */
const queryOf = (path: string): string | undefined =>
  mock
    .requests()
    .filter((request) => request.path === path)
    .at(-1)?.query;

const audits = async (): Promise<unknown[]> =>
  (await (await models.getAuditLogRepository()).list(wid, { action: 'integration.write' }, 50)).map(
    (entry) => entry.meta,
  );

describe('Google Calendar writes while read-only', () => {
  it('each new write is 409 integration_read_only, with zero non-GET requests', async () => {
    const { item } = await pulled('Read-only dentist');
    const before = writes();
    const readOnly = (error: unknown): boolean => hasCode(409, 'integration_read_only')(error);
    await assert.rejects(
      alice.insertEvent(caller, ALICE.email, event('h5rrule0001'), ['RRULE:FREQ=DAILY;COUNT=3']),
      readOnly,
    );
    await assert.rejects(alice.updateEvent(caller, item, { title: 'Renamed' }), readOnly);
    await assert.rejects(alice.deleteEvent(caller, item), readOnly);
    await assert.rejects(alice.createCalendar(caller, 'TodoList'), readOnly);
    assert.deepEqual(since(before), []);
    assert.deepEqual(mock.createdCalendars(), []);
  });
});

describe('Google Calendar writes once read & write', () => {
  it('insertEvent with a recurrence: the one RRULE line, as the parser writes it', async () => {
    alice = await switchToReadWrite(alice);
    const result = await alice.insertEvent(caller, ALICE.email, event('h5rrule0002'), [
      'RRULE:BYDAY=MO,WE;FREQ=WEEKLY;UNTIL=20261231T215959Z',
    ]);
    assert.equal(result.kind, 'created');
    const created = mock.events(ALICE.email).find((entry) => entry.id === 'h5rrule0002');
    assert.deepEqual(created?.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO,WE;UNTIL=20261231T215959Z']);
  });

  it('an invalid recurrence is a 400 before anything is sent (no token exchange either)', async () => {
    const before = writes();
    for (const recurrence of [
      ['RRULE:FREQ=HOURLY'],
      ['RRULE:FREQ=DAILY;BYSETPOS=1'],
      ['RRULE:FREQ=YEARLY;BYMONTHDAY=15'],
      ['EXDATE:20261124T050000Z'],
      ['RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY'],
      [],
      // A timed event's UNTIL must be a UTC time; an all-day event's a date.
      ['RRULE:FREQ=DAILY;UNTIL=20261231'],
    ]) {
      await assert.rejects(
        alice.insertEvent(caller, ALICE.email, event('h5rrule0003'), recurrence),
        hasStatus(400),
        JSON.stringify(recurrence),
      );
    }
    await assert.rejects(
      alice.insertEvent(
        caller,
        ALICE.email,
        event('h5rrule0004', { start: { date: '2026-11-23' }, end: { date: '2026-11-24' } }),
        ['RRULE:FREQ=DAILY;UNTIL=20261231T215959Z'],
      ),
      hasStatus(400),
    );
    assert.deepEqual(since(before), []);
  });

  it('only this integration’s event items on a calendar it reads: anything else is 404, nothing sent', async () => {
    mock.nextAuthorize('no_app_calendars');
    const bob = await switchToReadWrite(await connect(BOB));
    const bobs = await mirrorEvent('bobevent001', { integration: bob, calendarId: BOB.email });
    const { eventId } = await pulled('Mine');
    // The same event under another workspace (another tenant), on an unselected calendar.
    const otherWorkspace = (
      await (
        await models.getWorkspaceRepository()
      ).create({ name: 'Elsewhere', slug: `gwb-x-${randomUUID().slice(0, 8)}`, ownerId })
    ).id;
    const elsewhere = await mirrorEvent(eventId, { workspaceId: otherWorkspace });
    const unselected = await mirrorEvent('hiddencal01', {
      calendarId: 'work@group.calendar.example',
    });
    const local = await (
      await models.getItemRepository()
    ).createLocal(wid, { ownerUserId: ownerId, title: 'A to-do', topicId: null });
    const before = writes();
    for (const ref of [
      bobs,
      elsewhere,
      unselected,
      local,
      // A raw Google event id is not an item.
      { id: eventId },
      { id: 'missing' },
    ]) {
      await assert.rejects(alice.updateEvent(caller, ref, { title: 'x' }), hasStatus(404));
      await assert.rejects(alice.deleteEvent(caller, ref), hasStatus(404));
    }
    assert.deepEqual(since(before), []);
    assert.ok(
      mock.events(ALICE.email).some((entry) => entry.id === eventId),
      'untouched',
    );
  });

  it('updateEvent: one PATCH; the event and its item take the new title and time; audited at once', async () => {
    const { eventId, item } = await pulled('Dentist');
    const before = writes();
    const written = await alice.updateEvent(caller, item, {
      title: 'Dentist (moved)',
      description: 'Bring the forms',
      startAt: new Date('2026-11-25T08:00:00Z'),
      endAt: new Date('2026-11-25T09:00:00Z'),
    });
    assert.deepEqual(since(before), ['POST /token', `PATCH ${eventPath(eventId)}`]);
    assert.equal(queryOf(eventPath(eventId)), '', 'no guests: no sendUpdates');
    assert.equal(written.id, eventId);
    const atGoogle = mock.events(ALICE.email).find((entry) => entry.id === eventId);
    assert.equal(atGoogle?.summary, 'Dentist (moved)');
    assert.equal(atGoogle.description, 'Bring the forms');
    assert.deepEqual(atGoogle.start, {
      dateTime: '2026-11-25T08:00:00.000Z',
      timeZone: TZ,
      date: null,
    });
    const after = await (await models.getItemRepository()).findById(wid, item.id);
    assert.equal(after?.title, 'Dentist (moved)');
    assert.equal(after.startAt?.toISOString(), '2026-11-25T08:00:00.000Z');
    assert.equal(after.endAt?.toISOString(), '2026-11-25T09:00:00.000Z');
    assert.equal(after.source.hash, null);
    assert.deepEqual((await audits()).at(0), {
      operation: 'event.update',
      itemId: item.id,
      fields: ['title', 'description', 'startAt', 'endAt'],
    });
  });

  it('an edit or delete Google gives no answer to (a 5xx) is audited as unknown, then 502', async () => {
    const { item } = await pulled('Flaky');
    mock.failNextWrite(503);
    await assert.rejects(
      alice.updateEvent(caller, item, { title: 'Flaky (moved)' }),
      hasStatus(502),
    );
    assert.deepEqual((await audits()).at(0), {
      operation: 'event.update',
      itemId: item.id,
      fields: ['title'],
      outcome: 'unknown',
    });
    mock.failNextWrite(500);
    await assert.rejects(alice.deleteEvent(caller, item), hasStatus(502));
    assert.deepEqual((await audits()).at(0), {
      operation: 'event.delete',
      itemId: item.id,
      outcome: 'unknown',
    });
    // A refusal (a 4xx) is a clear no: not audited.
    mock.failNextWrite(403);
    const count = (await audits()).length;
    await assert.rejects(alice.deleteEvent(caller, item), hasStatus(409));
    assert.equal((await audits()).length, count);
  });

  it('an event write that Google refuses or leaves unanswered carries a code, its message unchanged', async () => {
    const { item } = await pulled('Coded');
    const failure = async (
      status: number,
      expected: { code: string; http: number; message: string },
    ): Promise<void> => {
      mock.failNextWrite(status);
      await assert.rejects(alice.updateEvent(caller, item, { title: `Coded ${String(status)}` }), {
        statusCode: expected.http,
        code: expected.code,
        message: expected.message,
      });
    };
    await failure(503, {
      code: 'provider_no_answer',
      http: 502,
      message: 'Google Calendar did not answer. Try again in a moment.',
    });
    await failure(401, {
      code: 'provider_refused',
      http: 409,
      message: 'Google refused the connection: reconnect Google Calendar',
    });
    await failure(403, {
      code: 'provider_refused',
      http: 409,
      message: 'Google refused this change for this account',
    });
  });

  it('updateEvent: all day (the other form cleared); an invalid edit 400; a gone event 404', async () => {
    const { eventId, item } = await pulled('Trip');
    await alice.updateEvent(caller, item, {
      startAt: new Date('2026-12-01T10:00:00Z'),
      endAt: new Date('2026-12-03T10:00:00Z'),
      allDay: true,
    });
    const atGoogle = mock.events(ALICE.email).find((entry) => entry.id === eventId);
    assert.deepEqual(atGoogle?.start, { date: '2026-12-01', dateTime: null, timeZone: null });
    assert.deepEqual(atGoogle.end, { date: '2026-12-03', dateTime: null, timeZone: null });
    const before = writes();
    await assert.rejects(alice.updateEvent(caller, item, { startAt: new Date() }), hasStatus(400));
    assert.deepEqual(since(before), []);
    // An item whose event Google no longer has.
    const gone = await mirrorEvent('nosuchevent9');
    await assert.rejects(
      alice.updateEvent(caller, gone, { title: 'x' }),
      hasCode(404, 'provider_item_missing'),
    );
  });

  it('an event with other guests: 409 event_has_guests unless notifyGuests, sent as sendUpdates', async () => {
    const meeting = await pulled('Team sync', { attendeesCount: 3, guestsCount: 2 });
    // Pulled before guestsCount was kept: any attendee reads as a guest (it fails closed: an event
    // made through the API lists its one guest, not its organizer).
    const older = await pulled('Old review', { attendeesCount: 2, guestsCount: undefined });
    const oneGuest = await pulled('One guest', { attendeesCount: 1, guestsCount: undefined });
    const before = writes();
    for (const { item } of [meeting, older, oneGuest]) {
      await assert.rejects(
        alice.updateEvent(caller, item, { title: 'Moved' }),
        hasCode(409, 'event_has_guests'),
      );
      await assert.rejects(alice.deleteEvent(caller, item), hasCode(409, 'event_has_guests'));
    }
    assert.deepEqual(since(before), []);
    await alice.updateEvent(
      caller,
      meeting.item,
      { title: 'Team sync (moved)' },
      { notifyGuests: true },
    );
    assert.equal(queryOf(eventPath(meeting.eventId)), '?sendUpdates=all');
    await alice.deleteEvent(caller, older.item, { notifyGuests: false });
    assert.equal(queryOf(eventPath(older.eventId)), '?sendUpdates=none');
    assert.equal(
      mock.events(ALICE.email).some((entry) => entry.id === older.eventId),
      false,
    );
  });

  it('deleteEvent: one DELETE, the item goes too, audited; a second delete finds no item', async () => {
    const { eventId, item } = await pulled('Cancelled lunch');
    const before = writes();
    await alice.deleteEvent(caller, item);
    assert.deepEqual(since(before), ['POST /token', `DELETE ${eventPath(eventId)}`]);
    assert.equal(
      mock.events(ALICE.email).some((entry) => entry.id === eventId),
      false,
    );
    assert.equal(await (await models.getItemRepository()).findById(wid, item.id), null);
    assert.deepEqual((await audits()).at(0), { operation: 'event.delete', itemId: item.id });
    await assert.rejects(alice.deleteEvent(caller, item), hasStatus(404));
  });

  it('deleteLinkedEvent: only this integration’s live to_google link with TodoList’s event id; tombstoned', async () => {
    const { eventIdFor } = await import('../../gcal/diff.js');
    const links = await models.getCalendarLinkRepository();
    const pushed = mock.addEvent(ALICE.email, {
      id: eventIdFor('todo-pushed-1'),
      summary: 'Pushed to-do',
      start: { date: '2026-11-28' },
      end: { date: '2026-11-29' },
    });
    const link = await links.upsert(
      wid,
      alice.id,
      { calendarId: ALICE.email, googleEventId: pushed.id },
      { itemId: 'todo-pushed-1', direction: 'to_google' },
    );
    // An event id TodoList never gives that item, and a link made from Google's side.
    await links.upsert(
      wid,
      alice.id,
      { calendarId: 'other@group.calendar.example', googleEventId: 'h5elsewhere1' },
      { itemId: 'todo-elsewhere-1', direction: 'to_google' },
    );
    await links.upsert(
      wid,
      alice.id,
      { calendarId: ALICE.email, googleEventId: eventIdFor('todo-from-google-1') },
      { itemId: 'todo-from-google-1', direction: 'from_google' },
    );
    const before = writes();
    for (const itemId of ['todo-elsewhere-1', 'todo-from-google-1', 'no-such-item', '']) {
      await assert.rejects(alice.deleteLinkedEvent(caller, { itemId }), hasStatus(404));
    }
    // Not a string (an operator object from an unchecked caller): 404, nothing read as a match.
    await assert.rejects(
      alice.deleteLinkedEvent(caller, { itemId: { $ne: null } } as unknown as { itemId: string }),
      hasStatus(404),
    );
    assert.deepEqual(since(before), []);
    await alice.deleteLinkedEvent(caller, { itemId: 'todo-pushed-1' });
    assert.deepEqual(since(before), ['POST /token', `DELETE ${eventPath(pushed.id)}`]);
    assert.equal(
      mock.events(ALICE.email).some((entry) => entry.id === pushed.id),
      false,
    );
    const tombstoned = await links.findByItem(wid, alice.id, 'todo-pushed-1');
    assert.equal(tombstoned?.id, link.id);
    assert.ok(tombstoned.tombstonedAt instanceof Date);
    assert.equal(tombstoned.deletedBy, 'dashboard');
    assert.deepEqual((await audits()).at(0), {
      operation: 'event.delete',
      itemId: 'todo-pushed-1',
    });
    await assert.rejects(
      alice.deleteLinkedEvent(caller, { itemId: 'todo-pushed-1' }),
      hasStatus(404),
    );
  });

  it('createCalendar: one calendars.insert in the workspace’s zone; it takes events', async () => {
    const before = writes();
    const created = await alice.createCalendar(caller, '  TodoList  ');
    assert.deepEqual(since(before), ['POST /token', 'POST /calendar/v3/calendars']);
    assert.deepEqual(
      { ...created, id: created.id.endsWith('@group.calendar.google.com') },
      { id: true, summary: 'TodoList', primary: false, accessRole: 'owner' },
    );
    assert.deepEqual(
      mock.createdCalendars().filter((calendar) => calendar.id === created.id),
      [{ id: created.id, summary: 'TodoList', timeZone: TZ }],
    );
    assert.deepEqual((await audits()).at(0), { operation: 'calendar.create' });
    // Read from now on, and recorded as TodoList's own (the only kind it may ever delete).
    const stored = await (await models.getIntegrationRepository()).findById(wid, alice.id);
    const config = stored?.config as {
      calendars: { id: string; mode: string }[];
      appCreatedCalendars?: string[];
    };
    assert.ok(config.calendars.some((calendar) => calendar.id === created.id));
    assert.deepEqual(config.appCreatedCalendars, [created.id]);
    // A settings change can't add to (or drop) that list.
    const reloaded = await load(alice.id);
    await reloaded.update(caller, {
      config: { ...config, appCreatedCalendars: [ALICE.email, 'forged@group.calendar.example'] },
    });
    const after = (await (await models.getIntegrationRepository()).findById(wid, alice.id))
      ?.config as { appCreatedCalendars?: string[] };
    assert.deepEqual(after.appCreatedCalendars, [created.id]);
    const inserted = await alice.insertEvent(caller, created.id, event('h5mine00001'));
    assert.equal(inserted.kind, 'created');
    await assert.rejects(alice.createCalendar(caller, '   '), hasStatus(400));
    await assert.rejects(alice.createCalendar(caller, 'Two\nlines'), hasStatus(400));
  });

  it('a grant from before calendar.app.created: createCalendar is 409 scope_missing, nothing sent', async () => {
    const bob = await load(
      (await Integration()).find((integration) => integration.accountId === BOB.sub)?.id ?? '',
    );
    const before = writes();
    await assert.rejects(
      bob.createCalendar(caller, 'TodoList'),
      (error: unknown) =>
        hasCode(409, 'scope_missing')(error) &&
        (error as Error).message.includes('connect it again'),
    );
    assert.deepEqual(since(before), []);
    // Everything else it was granted still works.
    const result = await bob.insertEvent(caller, BOB.email, event('h5oldgrant01'));
    assert.equal(result.kind, 'created');
  });

  it('nothing but loopback was connected to', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});

/** The caller's Google Calendar integrations here. */
async function Integration(): Promise<GoogleCalendarIntegration[]> {
  const { Integration: Base, GoogleCalendarIntegration: Google } = await import('./index.js');
  return (await Base.listOwn(caller)).filter(
    (integration): integration is GoogleCalendarIntegration => integration instanceof Google,
  );
}
