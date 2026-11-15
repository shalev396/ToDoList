/**
 * Google Calendar's new writes (CalendarProvider: updateEvent, deleteEvent, createCalendar, and
 * insertEvent with a recurrence), end to end against the mock Google with a real OAuth grant:
 * while read-only each is refused with zero non-GET requests; once read & write, each sends its one
 * allow-listed call and the event's item here follows; a recurrence is checked by the strict RRULE
 * parser before anything is sent; and a grant from before TodoList asked for
 * `calendar.app.created` answers `scope_missing` to createCalendar, before anything is opened.
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

/** The event's item here, as a sync of the calendar writes it (its source hash set). */
async function mirrorEvent(eventId: string): Promise<ItemData> {
  const items = await models.getItemRepository();
  const account = { provider: 'google_calendar' as const, accountId: alice.accountId };
  const externalId = `${ALICE.email}:${eventId}`;
  await items.bulkUpsert(wid, [
    {
      integrationId: alice.id,
      kind: 'event',
      topicId: null,
      title: 'Dentist',
      status: 'open',
      statusRaw: 'confirmed',
      startAt: new Date('2026-11-24T07:00:00Z'),
      endAt: new Date('2026-11-24T07:30:00Z'),
      allDay: false,
      props: { calendarId: ALICE.email, eventId },
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
  const stored = await items.findBySource(wid, { ...account, integrationId: alice.id }, externalId);
  assert.ok(stored !== null);
  return stored;
}

const audits = async (): Promise<unknown[]> =>
  (await (await models.getAuditLogRepository()).list(wid, { action: 'integration.write' }, 50)).map(
    (entry) => entry.meta,
  );

describe('Google Calendar writes while read-only', () => {
  it('each new write is 409 integration_read_only, with zero non-GET requests', async () => {
    const before = writes();
    const readOnly = (error: unknown): boolean => hasCode(409, 'integration_read_only')(error);
    await assert.rejects(
      alice.insertEvent(caller, ALICE.email, event('h5rrule0001'), ['RRULE:FREQ=DAILY;COUNT=3']),
      readOnly,
    );
    await assert.rejects(
      alice.updateEvent(caller, ALICE.email, 'evt00001', { title: 'Renamed' }),
      readOnly,
    );
    await assert.rejects(alice.deleteEvent(caller, ALICE.email, 'evt00001'), readOnly);
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

  it('updateEvent: one PATCH; the event and its item here take the new title and time', async () => {
    const added = mock.addEvent(ALICE.email, {
      summary: 'Dentist',
      start: { dateTime: '2026-11-24T07:00:00Z' },
      end: { dateTime: '2026-11-24T07:30:00Z' },
    });
    const item = await mirrorEvent(added.id);
    const before = writes();
    const written = await alice.updateEvent(caller, ALICE.email, added.id, {
      title: 'Dentist (moved)',
      description: 'Bring the forms',
      start: new Date('2026-11-25T08:00:00Z'),
      end: new Date('2026-11-25T09:00:00Z'),
    });
    assert.deepEqual(since(before), [
      'POST /token',
      `PATCH /calendar/v3/calendars/${encodeURIComponent(ALICE.email)}/events/${added.id}`,
    ]);
    assert.equal(written.id, added.id);
    const atGoogle = mock.events(ALICE.email).find((entry) => entry.id === added.id);
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
      fields: ['title', 'description', 'time'],
    });
  });

  it('updateEvent: all day (the other form cleared); an invalid edit 400 and a gone event 404', async () => {
    const added = mock.addEvent(ALICE.email, {
      summary: 'Trip',
      start: { dateTime: '2026-12-01T07:00:00Z' },
      end: { dateTime: '2026-12-01T08:00:00Z' },
    });
    await alice.updateEvent(caller, ALICE.email, added.id, {
      start: new Date('2026-12-01T10:00:00Z'),
      end: new Date('2026-12-03T10:00:00Z'),
      allDay: true,
    });
    const atGoogle = mock.events(ALICE.email).find((entry) => entry.id === added.id);
    assert.deepEqual(atGoogle?.start, { date: '2026-12-01', dateTime: null, timeZone: null });
    assert.deepEqual(atGoogle.end, { date: '2026-12-03', dateTime: null, timeZone: null });
    const before = writes();
    await assert.rejects(
      alice.updateEvent(caller, ALICE.email, added.id, { start: new Date() }),
      hasStatus(400),
    );
    await assert.rejects(
      alice.updateEvent(caller, ALICE.email, 'bad/id', { title: 'x' }),
      hasStatus(400),
    );
    assert.deepEqual(since(before), []);
    await assert.rejects(
      alice.updateEvent(caller, ALICE.email, 'nosuchevent1', { title: 'x' }),
      hasStatus(404),
    );
  });

  it('deleteEvent: one DELETE, the item here goes too, and a second delete is done', async () => {
    const added = mock.addEvent(ALICE.email, {
      summary: 'Cancelled lunch',
      start: { dateTime: '2026-11-26T10:00:00Z' },
      end: { dateTime: '2026-11-26T11:00:00Z' },
    });
    const item = await mirrorEvent(added.id);
    const before = writes();
    await alice.deleteEvent(caller, ALICE.email, added.id);
    assert.deepEqual(since(before), [
      'POST /token',
      `DELETE /calendar/v3/calendars/${encodeURIComponent(ALICE.email)}/events/${added.id}`,
    ]);
    assert.equal(
      mock.events(ALICE.email).some((entry) => entry.id === added.id),
      false,
    );
    assert.equal(await (await models.getItemRepository()).findById(wid, item.id), null);
    await alice.deleteEvent(caller, ALICE.email, added.id);
    assert.deepEqual((await audits()).at(0), { operation: 'event.delete' });
  });

  it('createCalendar: one calendars.insert in the workspace’s zone; it takes events', async () => {
    const before = writes();
    const created = await alice.createCalendar(caller, '  TodoList  ');
    assert.deepEqual(since(before), ['POST /token', 'POST /calendar/v3/calendars']);
    assert.deepEqual(
      { ...created, id: created.id.endsWith('@group.calendar.google.com') },
      { id: true, summary: 'TodoList', primary: false, accessRole: 'owner' },
    );
    assert.deepEqual(mock.createdCalendars(), [
      { id: created.id, summary: 'TodoList', timeZone: TZ },
    ]);
    assert.deepEqual((await audits()).at(0), { operation: 'calendar.create' });
    const inserted = await alice.insertEvent(caller, created.id, event('h5mine00001'));
    assert.equal(inserted.kind, 'created');
    await assert.rejects(alice.createCalendar(caller, '   '), hasStatus(400));
    await assert.rejects(alice.createCalendar(caller, 'Two\nlines'), hasStatus(400));
  });

  it('a grant from before calendar.app.created: createCalendar is 409 scope_missing, nothing sent', async () => {
    mock.nextAuthorize('no_app_calendars');
    const bob = await switchToReadWrite(await connect(BOB));
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
