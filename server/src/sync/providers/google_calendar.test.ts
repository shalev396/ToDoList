import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import mongoose from 'mongoose';

import type {
  IIntegrationRepository,
  IntegrationData,
} from '../../models/definitions/Integration.js';
import type { IContainerRepository } from '../../models/definitions/Container.js';
import type { ItemData } from '../../models/definitions/Item.js';
import type { ISyncRunRepository } from '../../models/definitions/SyncRun.js';
import type { ISyncStateRepository } from '../../models/definitions/SyncState.js';
import type { TopicRule, IWorkspaceRepository } from '../../models/definitions/Workspace.js';
import { ItemMongoModel } from '../../models/mongoose/Item.js';
import {
  decodeJwt,
  FAKE_CLIENT_EMAIL,
  FAKE_UNUSABLE_PEM,
  fakeServiceAccount,
} from '../../testing/fakeServiceAccount.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import {
  GOOGLE_TOKEN_URL,
  ProviderHttpError,
  type Clock,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from '../http.js';
import { setVaultLoaderForTests, type SyncVault } from '../secrets.js';
import {
  fixtureTransport,
  loadFixtureSet,
  type FixtureEntry,
  type FixtureTransport,
} from '../transports/fixtures.js';
import {
  ListingTooLargeError,
  type AdapterContext,
  type AdapterPage,
  type MappedItem,
  type ResourceResult,
  type SyncCounts,
  type SyncRunSummary,
} from '../types.js';
import {
  googleCalendarAdapter,
  MAX_EVENT_PAGES,
  mapCalendarEvent,
  UnmappableEventError,
  type CalendarEventContext,
  type GoogleCalendarEvent,
  type GoogleEventAttendee,
} from './google_calendar.js';
import { bindAuth } from '../../classes/integration/definitions/IntegrationDefinition.js';
import { GOOGLE_CALENDAR_AUTH } from '../../classes/integration/definitions/googleCalendarAuth.js';

const NOW = new Date('2026-11-12T08:00:00.000Z');
const COLLEGE = 'college@example.invalid';

const CTX: CalendarEventContext = {
  calendarId: COLLEGE,
  accountId: 'demo-sa@example.invalid',
  timeZone: 'Asia/Jerusalem',
};

/** mapCalendarEvent of an event that is not a deletion: the item. */
function mapLive(raw: GoogleCalendarEvent, ctx: CalendarEventContext = CTX): MappedItem {
  const mapped = mapCalendarEvent(raw, ctx);
  assert.ok(!('deleted' in mapped), 'an item, not a delete-only record');
  return mapped;
}

/** A confirmed timed event, as events.list returns it. */
function event(extra: Partial<GoogleCalendarEvent> = {}): GoogleCalendarEvent {
  return {
    kind: 'calendar#event',
    etag: '"3420000000000001"',
    id: 'algtoday001',
    status: 'confirmed',
    htmlLink: 'https://example.invalid/calendar/event?eid=FAKEalgtoday001',
    updated: '2026-11-10T07:00:00.000Z',
    summary: 'Algorithms lecture',
    location: 'Building M, Room 201',
    start: { dateTime: '2026-11-12T08:30:00+02:00', timeZone: 'Asia/Jerusalem' },
    end: { dateTime: '2026-11-12T10:20:00+02:00', timeZone: 'Asia/Jerusalem' },
    ...extra,
  };
}

describe('mapCalendarEvent', () => {
  it('maps a timed event: title, times, link, calendar-scoped id, container and props', () => {
    assert.deepEqual(mapCalendarEvent(event(), CTX), {
      kind: 'event',
      title: 'Algorithms lecture',
      status: 'open',
      statusRaw: 'confirmed',
      startAt: new Date('2026-11-12T06:30:00.000Z'),
      endAt: new Date('2026-11-12T08:20:00.000Z'),
      allDay: false,
      closedAt: null,
      containerExternalId: COLLEGE,
      props: {
        calendarId: COLLEGE,
        eventId: 'algtoday001',
        location: 'Building M, Room 201',
        meetLink: null,
        recurringEventId: null,
        recurrence: null,
        originalStartAt: null,
        attendeesCount: 0,
        transparency: 'opaque',
      },
      source: {
        provider: 'google_calendar',
        accountId: 'demo-sa@example.invalid',
        externalId: `${COLLEGE}:algtoday001`,
        key: null,
        url: 'https://example.invalid/calendar/event?eid=FAKEalgtoday001',
        updatedAtSource: new Date('2026-11-10T07:00:00.000Z'),
        etag: '"3420000000000001"',
        hash: null,
      },
    });
  });

  it('places an all-day event at local midnight in the workspace zone, with Google’s exclusive end', () => {
    const allDay = event({ start: { date: '2026-11-15' }, end: { date: '2026-11-16' } });
    const jerusalem = mapLive(allDay);
    assert.deepEqual(
      [jerusalem.startAt, jerusalem.endAt, jerusalem.allDay],
      [new Date('2026-11-14T22:00:00.000Z'), new Date('2026-11-15T22:00:00.000Z'), true],
    );
    const newYork = mapLive(allDay, { ...CTX, timeZone: 'America/New_York' });
    assert.deepEqual(
      [newYork.startAt, newYork.endAt],
      [new Date('2026-11-15T05:00:00.000Z'), new Date('2026-11-16T05:00:00.000Z')],
    );
    // Before Israel's clocks went back (2026-10-25): midnight is 21:00 UTC, not 22:00.
    const summer = mapLive(event({ start: { date: '2026-10-24' }, end: { date: '2026-10-25' } }));
    assert.deepEqual(summer.startAt, new Date('2026-10-23T21:00:00.000Z'));
    assert.deepEqual(summer.endAt, new Date('2026-10-24T21:00:00.000Z'));
  });

  it('normalizes the status: confirmed and tentative are open, a declined invitation is closed', () => {
    const self = (responseStatus: string): GoogleEventAttendee[] => [
      { email: COLLEGE, self: true, responseStatus },
      { email: 'noa@example.invalid', responseStatus: 'accepted' },
    ];
    const rows: [string, GoogleCalendarEvent, unknown[]][] = [
      ['confirmed', event(), ['open', 'confirmed', null]],
      ['tentative', event({ status: 'tentative' }), ['open', 'tentative', null]],
      ['self accepted', event({ attendees: self('accepted') }), ['open', 'confirmed', null]],
      [
        'self declined',
        event({ attendees: self('declined') }),
        ['cancelled', 'declined', new Date('2026-11-10T07:00:00.000Z')],
      ],
      [
        'another guest declined',
        event({
          attendees: [
            { email: COLLEGE, self: true, responseStatus: 'accepted' },
            { email: 'noa@example.invalid', responseStatus: 'declined' },
          ],
        }),
        ['open', 'confirmed', null],
      ],
      [
        'cancelled instance of a series: kept, closed',
        event({
          status: 'cancelled',
          recurringEventId: 'dsweekly001',
          originalStartTime: { dateTime: '2026-11-12T08:30:00+02:00' },
        }),
        ['cancelled', 'cancelled', new Date('2026-11-10T07:00:00.000Z')],
      ],
    ];
    for (const [name, raw, expected] of rows) {
      const mapped = mapLive(raw);
      assert.deepEqual([mapped.status, mapped.statusRaw, mapped.closedAt], expected, name);
      assert.equal(mapped.deletedAt, undefined, `${name}: never a deletion`);
    }
  });

  it('a cancelled single event or whole series is a delete-only record: its id, nothing else', () => {
    const deleted = { externalId: `${COLLEGE}:algtoday001`, deleted: true };
    const rows: [string, GoogleCalendarEvent][] = [
      ['a single event', event({ status: 'cancelled' })],
      ['a series (its master)', event({ status: 'cancelled', recurrence: ['RRULE:FREQ=WEEKLY'] })],
      ['its id only', { kind: 'calendar#event', id: 'algtoday001', status: 'cancelled' }],
      ['no link: none is made up', event({ status: 'cancelled', htmlLink: '' })],
      ['times it cannot place: not needed', event({ status: 'cancelled', start: { date: 'x' } })],
    ];
    for (const [name, raw] of rows) assert.deepEqual(mapCalendarEvent(raw, CTX), deleted, name);
    // No id: the engine fails it as missing_id.
    assert.deepEqual(mapCalendarEvent({ status: 'cancelled' }, CTX), {
      externalId: '',
      deleted: true,
    });
  });

  it('maps a recurring series and its exceptions: recurrence, series id, original start', () => {
    const recurrence = Object.freeze(['RRULE:FREQ=WEEKLY;COUNT=12', 'EXDATE:20261119T080000Z']);
    const master = mapLive(event({ id: 'dsweekly001', recurrence: recurrence as string[] }));
    assert.deepEqual(master.props?.['recurrence'], [
      'EXDATE:20261119T080000Z',
      'RRULE:FREQ=WEEKLY;COUNT=12',
    ]);
    assert.deepEqual(recurrence, ['RRULE:FREQ=WEEKLY;COUNT=12', 'EXDATE:20261119T080000Z']);

    const moved = mapLive(
      event({
        id: 'dsweekly001_r1',
        recurringEventId: 'dsweekly001',
        originalStartTime: { dateTime: '2026-11-06T10:00:00+02:00' },
        start: { dateTime: '2026-11-06T13:00:00+02:00' },
        end: { dateTime: '2026-11-06T15:00:00+02:00' },
      }),
    );
    assert.deepEqual(
      [moved.props?.['recurringEventId'], moved.props?.['originalStartAt'], moved.startAt],
      ['dsweekly001', '2026-11-06T08:00:00.000Z', new Date('2026-11-06T11:00:00.000Z')],
    );

    // A cancelled instance may carry only its id, series and original start. It stays live (an
    // item, not a delete-only record), so the client can hide that one occurrence of the series.
    const dropped = mapLive({
      id: 'dsweekly001_r2',
      status: 'cancelled',
      recurringEventId: 'dsweekly001',
      originalStartTime: { dateTime: '2026-11-20T10:00:00+02:00' },
    });
    const eid = Buffer.from(`dsweekly001_r2 ${COLLEGE}`).toString('base64url');
    assert.deepEqual(
      [
        dropped.status,
        dropped.closedAt,
        dropped.startAt,
        dropped.props?.['recurringEventId'],
        dropped.props?.['originalStartAt'],
        dropped.source.url,
      ],
      [
        'cancelled',
        null,
        new Date('2026-11-20T08:00:00.000Z'),
        'dsweekly001',
        '2026-11-20T08:00:00.000Z',
        `https://www.google.com/calendar/event?eid=${eid}`,
      ],
    );
  });

  it('meet link from conferenceData, rooms are not guests, free time stays transparent', () => {
    const mapped = mapLive(
      event({
        transparency: 'transparent',
        conferenceData: {
          entryPoints: [
            { entryPointType: 'phone', uri: 'tel:+1-555-0100' },
            { entryPointType: 'video', uri: 'https://example.invalid/meet/FAKE-xyz' },
          ],
        },
        attendees: [
          { email: COLLEGE, self: true, responseStatus: 'accepted' },
          { email: 'dana@example.invalid', responseStatus: 'needsAction' },
          { email: 'room-3@example.invalid', resource: true, responseStatus: 'accepted' },
        ],
      }),
    );
    assert.deepEqual(
      [
        mapped.props?.['meetLink'],
        mapped.props?.['attendeesCount'],
        mapped.props?.['transparency'],
      ],
      ['https://example.invalid/meet/FAKE-xyz', 2, 'transparent'],
    );
    const hangout = mapLive(event({ hangoutLink: 'https://example.invalid/meet/FAKE-abc' }));
    assert.equal(hangout.props?.['meetLink'], 'https://example.invalid/meet/FAKE-abc');
  });

  it('an event with no link maps with an empty URL (the engine fails it as missing_url)', () => {
    assert.equal(mapLive(event({ htmlLink: '' })).source.url, '');
    const noLink = event();
    delete noLink.htmlLink;
    assert.equal(mapLive(noLink).source.url, '');
  });

  it('an untitled event is titled by its id (Google allows events without a summary)', () => {
    const untitled = event();
    delete untitled.summary;
    assert.equal(mapLive(untitled).title, 'algtoday001');
    assert.equal(mapLive(event({ summary: '   ' })).title, 'algtoday001');
  });

  it('refuses times it cannot place, with a code and never a guess', () => {
    const bad: [string, GoogleCalendarEvent][] = [
      ['no start', event({ start: undefined as never })],
      ['empty start', event({ start: {} })],
      ['not a date', event({ start: { dateTime: 'soon' } })],
      ['no offset (floating time)', event({ start: { dateTime: '2026-11-12T08:30:00' } })],
      ['impossible day', event({ start: { date: '2026-02-30' }, end: { date: '2026-03-01' } })],
      ['bad end', event({ end: { dateTime: '2026-13-01T00:00:00Z' } })],
      ['bad original start', event({ originalStartTime: { date: '20261106' } })],
    ];
    for (const [name, raw] of bad) {
      assert.throws(
        () => mapCalendarEvent(raw, CTX),
        (error: unknown) =>
          error instanceof UnmappableEventError && error.code === 'bad_event_time',
        name,
      );
    }
  });

  it('is pure: the same event maps the same, and no client or clock is involved', () => {
    const raw = Object.freeze(event({ attendees: Object.freeze([]) as never }));
    assert.deepEqual(mapCalendarEvent(raw, CTX), mapCalendarEvent(raw, CTX));
  });
});

// ---------------------------------------------------------------------------------------------
// The adapter, through the real engine (memory MongoDB) and the recorded fixtures.
// ---------------------------------------------------------------------------------------------

const PERSONAL = 'personal@example.invalid';
const FIXTURES_DIR = fileURLToPath(new URL('../fixtures/google_calendar/', import.meta.url));
const DAY_MS = 24 * 60 * 60 * 1000;
const ACCESS_TOKEN = 'ya29.FAKE-calendar-access-token';
const EVENTS_API = 'https://www.googleapis.com/calendar/v3/calendars';

interface Repositories {
  workspaces: IWorkspaceRepository;
  integrations: IIntegrationRepository;
  containers: IContainerRepository;
  runs: ISyncRunRepository;
  states: ISyncStateRepository;
}

let db: TestDatabase;
let guard: OutboundGuard;
let r: Repositories;

before(async () => {
  // Environment first: config/environment.ts reads it when first imported (by the engine).
  db = await startTestDatabase('todolist_google_calendar_test');
  guard = installOutboundGuard();
  const m = await import('../../models/index.js');
  r = {
    workspaces: await m.getWorkspaceRepository(),
    integrations: await m.getIntegrationRepository(),
    containers: await m.getContainerRepository(),
    runs: await m.getSyncRunRepository(),
    states: await m.getSyncStateRepository(),
  };
});

after(async () => {
  guard.restore();
  await db.stop();
});

afterEach(() => {
  setVaultLoaderForTests(null);
});

interface Setup {
  workspaceId: string;
  integration: IntegrationData;
}

let setups = 0;

async function setup(options: { rules?: TopicRule[]; calendars?: unknown[] } = {}): Promise<Setup> {
  setups += 1;
  const workspace = await r.workspaces.create({
    name: `Calendar ${String(setups)}`,
    slug: `calendar-${String(setups)}`,
    ownerId: 'u-owner',
    settings: { topicRules: options.rules ?? [] },
  });
  const integration = await r.integrations.create(workspace.id, {
    connectedBy: 'u-owner',
    provider: 'google_calendar',
    accountId: `demo-${String(setups)}@example.invalid`,
    label: 'Google Calendar (demo)',
    authMethod: 'service_account',
    topicId: 'personal',
    config: { calendars: options.calendars ?? [{ id: PERSONAL }, { id: COLLEGE }] },
  });
  return { workspaceId: workspace.id, integration };
}

/** A recorded set, its dates resolved against NOW (so a run near midnight cannot flake). */
async function fixtures(set: 'v1' | 'v2'): Promise<FixtureTransport> {
  return fixtureTransport(await loadFixtureSet(join(FIXTURES_DIR, set)), { now: NOW });
}

async function sync(
  s: Setup,
  transport: Transport,
  mode: 'fixtures' | 'live' = 'fixtures',
  now: Date = NOW,
): Promise<SyncRunSummary> {
  const { runIntegrationSync } = await import('../runSync.js');
  return runIntegrationSync(s.integration.id, { trigger: 'manual', mode, now, transport });
}

function counts(partial: Partial<SyncCounts>): SyncCounts {
  return {
    fetched: 0,
    inserted: 0,
    updated: 0,
    unchanged: 0,
    closed: 0,
    deleted: 0,
    failed: 0,
    ...partial,
  };
}

/** Every item of the integration, soft-deleted ones included, by external id. */
async function itemsOf(s: Setup): Promise<Map<string, ItemData>> {
  const docs = await ItemMongoModel.find({
    workspaceId: s.workspaceId,
    integrationId: s.integration.id,
  }).lean<(Omit<ItemData, 'id'> & { _id: string })[]>();
  return new Map(docs.map((doc) => [doc.source.externalId, { ...doc, id: doc._id }]));
}

function item(items: Map<string, ItemData>, calendarId: string, eventId: string): ItemData {
  const found = items.get(`${calendarId}:${eventId}`);
  assert.ok(found, `${calendarId}:${eventId}`);
  return found;
}

/** Local wall-clock time in Asia/Jerusalem (UTC+2 in November) on NOW's day + `days`. */
function local(days: number, hhmm: string): Date {
  const [hours = 0, minutes = 0] = hhmm.split(':').map(Number);
  return new Date(Date.UTC(2026, 10, 12 + days, hours - 2, minutes));
}

function queryOf(request: HttpRequest): URLSearchParams {
  return new URL(request.url).searchParams;
}

function eventsUrl(calendarId: string): string {
  return `${EVENTS_API}/${encodeURIComponent(calendarId)}/events`;
}

const TOKEN_FIXTURE: FixtureEntry = {
  request: { method: 'POST', url: GOOGLE_TOKEN_URL },
  response: { body: { access_token: ACCESS_TOKEN, expires_in: 3599, token_type: 'Bearer' } },
};

/** One page of events of `calendarId` (no further pages). */
function eventsPage(
  calendarId: string,
  items: object[],
  extra: Record<string, unknown> = {},
): FixtureEntry {
  return {
    request: { url: eventsUrl(calendarId) },
    response: {
      body: {
        kind: 'calendar#events',
        summary: 'Test calendar',
        timeZone: 'Asia/Jerusalem',
        items,
        ...extra,
      },
    },
  };
}

function timedEvent(id: string, start: Date, minutes = 60): object {
  return {
    kind: 'calendar#event',
    id,
    status: 'confirmed',
    htmlLink: `https://example.invalid/calendar/event?eid=FAKE-${id}`,
    summary: `Event ${id}`,
    start: { dateTime: start.toISOString() },
    end: { dateTime: new Date(start.getTime() + minutes * 60_000).toISOString() },
  };
}

function contextFor(
  s: Setup,
  transport: Transport,
  secret: Readonly<Record<string, string>>,
  clock?: Clock,
): AdapterContext {
  const client = googleCalendarAdapter.createClient(transport, clock);
  return {
    integration: s.integration,
    client,
    // The headers come from the integration's auth strategy, as in a run.
    auth: bindAuth(GOOGLE_CALENDAR_AUTH, s.integration.authMethod, { secret, client, now: NOW }),
    now: NOW,
    timeZone: 'Asia/Jerusalem',
    fullSyncDue: false,
  };
}

/** The throttle never waits: hundreds of pages are listed at once. */
const INSTANT: Clock = { now: () => 0, sleep: () => Promise.resolve() };

/**
 * A calendar whose events.list pages are generated: `page(pageToken)` answers each page. The
 * token exchange is answered too; every request is counted.
 */
function generatedCalendar(
  page: (pageToken: string | null) => Record<string, unknown>,
): Transport & { requests: HttpRequest[] } {
  const requests: HttpRequest[] = [];
  return {
    requests,
    send: (request: HttpRequest): Promise<HttpResponse> => {
      requests.push(request);
      const body =
        request.method === 'POST'
          ? { access_token: ACCESS_TOKEN, token_type: 'Bearer' }
          : {
              kind: 'calendar#events',
              summary: 'Generated',
              items: [],
              ...page(new URL(request.url).searchParams.get('pageToken')),
            };
      return Promise.resolve({ status: 200, headers: {}, body: JSON.stringify(body) });
    },
  };
}

async function drain(
  pages: AsyncGenerator<AdapterPage, ResourceResult>,
): Promise<{ pages: AdapterPage[]; result: ResourceResult }> {
  const seen: AdapterPage[] = [];
  for (;;) {
    const step = await pages.next();
    if (step.done === true) return { pages: seen, result: step.value };
    seen.push(step.value);
  }
}

function stubVault(secret: Record<string, string>): void {
  const vault: SyncVault = { decryptForSync: async (_integrationId, fn) => fn(secret) };
  setVaultLoaderForTests(() => Promise.resolve(vault));
}

/** Everything written to stderr while `fn` runs (the logger writes there). */
async function captureStderr(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

/** Every document of every collection, as one string. */
async function everythingStored(): Promise<string> {
  const database = mongoose.connection.db;
  assert.ok(database);
  const dump: unknown[] = [];
  for (const { name } of await database.listCollections().toArray()) {
    dump.push(name, await database.collection(name).find().toArray());
  }
  return JSON.stringify(dump);
}

describe('google_calendar adapter: resources', () => {
  it('one resource per configured calendar, in order, deduplicated; none when none is configured', () => {
    const configured = (calendars: unknown): IntegrationData =>
      ({ config: { calendars } }) as unknown as IntegrationData;
    assert.deepEqual(
      googleCalendarAdapter.resources(
        configured([{ id: PERSONAL }, COLLEGE, { id: PERSONAL }, { id: '' }, 42, null, {}]),
      ),
      [`calendar:${PERSONAL}`, `calendar:${COLLEGE}`],
    );
    assert.deepEqual(googleCalendarAdapter.resources(configured(undefined)), []);
  });
});

describe('google_calendar sync: fixtures v1 → v1 → v2 (incremental)', () => {
  let s: Setup;
  const calls: HttpRequest[] = [];

  before(async () => {
    s = await setup({ rules: [{ match: 'Braude*', topicId: 'college' }] });
  });

  it('v1: two calendars listed in full, 12 events in (one a cancelled occurrence), the one without a link fails', async () => {
    const transport = await fixtures('v1');
    const summary = await sync(s, transport);
    calls.push(...transport.calls);
    assert.equal(summary.status, 'partial');
    assert.deepEqual(summary.counts, counts({ fetched: 13, inserted: 12, failed: 1 }));

    const containers = await r.containers.list(s.workspaceId, { integrationId: s.integration.id });
    assert.deepEqual(
      containers.map((c) => [
        c.name,
        c.type,
        c.topicId,
        c.source.externalId,
        c.source.url,
        c.props,
      ]),
      [
        [
          'Braude Classes',
          'calendar',
          'college',
          COLLEGE,
          'https://calendar.google.com/calendar/r?cid=college%40example.invalid',
          { calendarId: COLLEGE, timeZone: 'Asia/Jerusalem' },
        ],
        [
          'Shalev (demo)',
          'calendar',
          'personal',
          PERSONAL,
          'https://calendar.google.com/calendar/r?cid=personal%40example.invalid',
          { calendarId: PERSONAL, timeZone: 'Asia/Jerusalem' },
        ],
      ],
    );

    const items = await itemsOf(s);
    assert.deepEqual(
      [...items.keys()].sort(),
      [
        ...[
          'algtoday001',
          'dsweekly001',
          'dsweekly001_r1',
          'dsweekly001_r2',
          'midterm001',
          'physlab001',
        ].map((id) => `${COLLEGE}:${id}`),
        ...['coffee001', 'dentist001', 'gym001', 'lunch001', 'planning001', 'standup001'].map(
          (id) => `${PERSONAL}:${id}`,
        ),
      ].sort(),
    );
    // Areas follow the calendar: the "Braude*" rule for classes, the integration's otherwise.
    for (const stored of items.values()) {
      const calendarId = stored.props['calendarId'];
      assert.equal(stored.topicId, calendarId === COLLEGE ? 'college' : 'personal');
      assert.equal(
        stored.containerId,
        containers.find((c) => c.source.externalId === calendarId)?.id,
      );
      assert.equal(stored.kind, 'event');
      assert.equal(stored.deletedAt, null);
    }

    // Today's 24h clock: lecture, standup, lunch, lab, planning, gym.
    const today = [...items.values()]
      .filter(
        (e) =>
          e.startAt !== null && e.startAt >= local(0, '00:00') && e.startAt < local(1, '00:00'),
      )
      .sort((a, b) => (a.startAt?.getTime() ?? 0) - (b.startAt?.getTime() ?? 0))
      .map((e) => [e.title, e.startAt, e.endAt]);
    assert.deepEqual(today, [
      ['Algorithms lecture', local(0, '08:30'), local(0, '10:20')],
      ['Team standup', local(0, '10:30'), local(0, '11:00')],
      ['Lunch with Noa', local(0, '12:30'), local(0, '13:30')],
      ['Physics 1 lab', local(0, '14:00'), local(0, '17:00')],
      ['Sprint planning', local(0, '17:30'), local(0, '18:30')],
      ['Gym', local(0, '19:30'), local(0, '21:00')],
    ]);

    const standup = item(items, PERSONAL, 'standup001');
    assert.deepEqual(
      [standup.props['meetLink'], standup.props['attendeesCount'], standup.source.url],
      [
        'https://example.invalid/meet/FAKE-abc-defg-hij',
        4,
        'https://example.invalid/calendar/event?eid=FAKE-standup001',
      ],
    );
    const planning = item(items, PERSONAL, 'planning001');
    assert.deepEqual(
      [planning.props['meetLink'], planning.props['attendeesCount'], planning.status],
      ['https://example.invalid/meet/FAKE-xyz-pqrs-tuv', 5, 'open'],
    );
    const midterm = item(items, COLLEGE, 'midterm001');
    assert.deepEqual(
      [midterm.allDay, midterm.startAt, midterm.endAt, midterm.props['transparency']],
      [true, local(4, '00:00'), local(5, '00:00'), 'transparent'],
    );
    const series = item(items, COLLEGE, 'dsweekly001');
    assert.deepEqual(
      [series.startAt, series.props['recurrence']],
      [local(-13, '10:00'), ['RRULE:FREQ=WEEKLY;COUNT=12']],
    );
    const moved = item(items, COLLEGE, 'dsweekly001_r1');
    assert.deepEqual(
      [moved.startAt, moved.props['recurringEventId'], moved.props['originalStartAt']],
      [local(-6, '13:00'), 'dsweekly001', local(-6, '10:00').toISOString()],
    );
    // Next week's lecture is cancelled: a live item the client uses to hide that occurrence.
    const cancelled = item(items, COLLEGE, 'dsweekly001_r2');
    assert.deepEqual(
      [
        cancelled.status,
        cancelled.deletedAt,
        cancelled.startAt,
        cancelled.props['recurringEventId'],
        cancelled.props['originalStartAt'],
      ],
      ['cancelled', null, local(8, '10:00'), 'dsweekly001', local(8, '10:00').toISOString()],
    );

    const runDoc = await r.runs.findById(s.workspaceId, summary.runId ?? '');
    assert.deepEqual(runDoc?.failures, [
      { externalId: `${COLLEGE}:officehours001`, code: 'missing_url' },
    ]);
    for (const [calendarId, token] of [
      [PERSONAL, 'FAKE-sync-personal-v1'],
      [COLLEGE, 'FAKE-sync-college-v1'],
    ] as const) {
      const state = await r.states.get(s.workspaceId, s.integration.id, `calendar:${calendarId}`);
      assert.deepEqual([state?.syncToken, state?.lastFullSyncAt], [token, NOW]);
    }

    // Full listings: from 30 days back, recurring events as series, deletions included.
    const lists = transport.calls.filter((call) => call.method === 'GET');
    assert.equal(lists.length, 3, 'personal (2 pages) and college (1 page)');
    for (const list of lists) {
      const query = queryOf(list);
      assert.deepEqual(
        [
          query.get('timeMin'),
          query.get('syncToken'),
          query.get('singleEvents'),
          query.get('showDeleted'),
        ],
        [new Date(NOW.getTime() - 30 * DAY_MS).toISOString(), null, 'false', 'true'],
      );
    }
  });

  it('v1 again: incremental from the stored sync tokens, and nothing changes', async () => {
    const before = await itemsOf(s);
    const transport = await fixtures('v1');
    const summary = await sync(s, transport);
    calls.push(...transport.calls);
    assert.deepEqual(summary.counts, counts({ fetched: 13, unchanged: 12, failed: 1 }));
    for (const [externalId, stored] of await itemsOf(s)) {
      assert.deepEqual(stored.updatedAt, before.get(externalId)?.updatedAt, externalId);
    }
    const tokens = transport.calls
      .filter((call) => call.method === 'GET')
      .map((call) => [queryOf(call).get('syncToken'), queryOf(call).get('timeMin')]);
    assert.deepEqual(tokens, [
      ['FAKE-sync-personal-v1', null],
      ['FAKE-sync-personal-v1', null],
      ['FAKE-sync-college-v1', null],
    ]);
    const state = await r.states.get(s.workspaceId, s.integration.id, `calendar:${PERSONAL}`);
    assert.deepEqual([state?.lastIncrementalAt, state?.lastFullSyncAt], [NOW, NOW]);
  });

  it('v2: the lecture moved rooms (updated), planning was declined (closed), the dentist was deleted by id', async () => {
    const transport = await fixtures('v2');
    const summary = await sync(s, transport);
    calls.push(...transport.calls);
    assert.equal(summary.status, 'succeeded');
    assert.deepEqual(summary.counts, counts({ fetched: 3, updated: 2, closed: 1, deleted: 1 }));
    const items = await itemsOf(s);
    assert.equal(item(items, COLLEGE, 'algtoday001').props['location'], 'Building M, Room 305');
    const planning = item(items, PERSONAL, 'planning001');
    assert.deepEqual(
      [planning.status, planning.statusRaw, planning.closedAt, planning.deletedAt],
      ['cancelled', 'declined', local(-1, '20:00'), null],
    );
    // The tombstone carries the id only: the stored copy is deleted and keeps its history.
    const dentist = item(items, PERSONAL, 'dentist001');
    assert.deepEqual(
      [dentist.deletedAt, dentist.title, dentist.status, dentist.startAt, dentist.source.url],
      [
        NOW,
        'Dentist',
        'open',
        local(2, '16:00'),
        'https://example.invalid/calendar/event?eid=FAKE-dentist001',
      ],
    );
    const live = [...items.values()].filter((e) => e.deletedAt === null);
    assert.equal(live.length, 11, 'every other event is kept');
    for (const [calendarId, token] of [
      [PERSONAL, 'FAKE-sync-personal-v2'],
      [COLLEGE, 'FAKE-sync-college-v2'],
    ] as const) {
      const state = await r.states.get(s.workspaceId, s.integration.id, `calendar:${calendarId}`);
      assert.equal(state?.syncToken, token);
    }
  });

  it('only GETs to the Calendar API left the adapter, plus one token exchange per calendar per run', () => {
    assert.ok(calls.length > 0);
    for (const call of calls) {
      if (call.method === 'GET') {
        assert.ok(call.url.startsWith(`${EVENTS_API}/`), call.url);
        assert.equal(call.body, undefined);
      } else {
        assert.deepEqual(
          [call.method, call.url, call.headers['content-type'], call.graphqlOperation],
          ['POST', GOOGLE_TOKEN_URL, 'application/x-www-form-urlencoded', undefined],
        );
      }
    }
    assert.equal(calls.filter((call) => call.method === 'POST').length, 6, '2 calendars × 3 runs');
    assert.deepEqual(guard.externalHosts(), []);
  });
});

describe('google_calendar sync: deletions', () => {
  it('a deletion listed again (full listings return tombstones) is unchanged: its deletedAt is kept', async () => {
    const s = await setup({ calendars: [{ id: PERSONAL }] });
    const start = new Date(NOW.getTime() + DAY_MS);
    // No nextSyncToken: every run lists the calendar in full, as a daily full sync does.
    const listing = (events: object[]): FixtureTransport =>
      fixtureTransport([TOKEN_FIXTURE, eventsPage(PERSONAL, events)], { now: NOW });
    await sync(s, listing([timedEvent('dentist001', start), timedEvent('kept001', start)]));
    const tombstones = [
      { kind: 'calendar#event', id: 'dentist001', status: 'cancelled' },
      { kind: 'calendar#event', id: 'never001', status: 'cancelled' },
    ];
    const deletedAt = new Date(NOW.getTime() + 60 * 60 * 1000);
    const first = await sync(
      s,
      listing([...tombstones, timedEvent('kept001', start)]),
      'fixtures',
      deletedAt,
    );
    assert.deepEqual(first.counts, counts({ fetched: 3, unchanged: 1, deleted: 1 }));
    const again = await sync(
      s,
      listing([...tombstones, timedEvent('kept001', start)]),
      'fixtures',
      new Date(NOW.getTime() + 2 * 60 * 60 * 1000),
    );
    assert.deepEqual(again.counts, counts({ fetched: 3, unchanged: 2 }));
    const items = await itemsOf(s);
    const dentist = item(items, PERSONAL, 'dentist001');
    assert.deepEqual(
      [dentist.deletedAt, dentist.title, dentist.startAt],
      [deletedAt, 'Event dentist001', start],
      'deleted once; the purge clock is not reset',
    );
    assert.equal(items.has(`${PERSONAL}:never001`), false, 'a tombstone of an unknown event');
  });
});

describe('google_calendar sync: full listings are windowed', () => {
  it('returns fullSync with the window startAt ∈ [now − 30 d, now + 90 d)', async () => {
    const s = await setup({ calendars: [{ id: PERSONAL }] });
    const transport = fixtureTransport([TOKEN_FIXTURE, eventsPage(PERSONAL, [])], { now: NOW });
    const { result } = await drain(
      googleCalendarAdapter.fetch(contextFor(s, transport, {}), `calendar:${PERSONAL}`, null),
    );
    assert.deepEqual(result, {
      nextState: { syncToken: null },
      fullSync: true,
      window: {
        field: 'startAt',
        from: new Date(NOW.getTime() - 30 * DAY_MS),
        to: new Date(NOW.getTime() + 90 * DAY_MS),
      },
    });
  });

  it('v2 in full (a full sync is due): the missing dentist is swept, the rest matches the delta', async () => {
    const s = await setup({ rules: [{ match: 'Braude*', topicId: 'college' }] });
    await sync(s, await fixtures('v1'));
    await r.states.upsert(s.workspaceId, s.integration.id, '__run__', {
      lastFullSyncAt: new Date(NOW.getTime() - 2 * DAY_MS),
    });
    const transport = await fixtures('v2');
    const summary = await sync(s, transport);
    assert.deepEqual(
      summary.counts,
      counts({ fetched: 12, updated: 2, unchanged: 9, closed: 1, deleted: 1, failed: 1 }),
    );
    assert.ok(
      transport.calls.every((call) => call.method === 'POST' || queryOf(call).has('timeMin')),
      'full listings',
    );
    const items = await itemsOf(s);
    assert.deepEqual(item(items, PERSONAL, 'dentist001').deletedAt, NOW);
    assert.equal(item(items, PERSONAL, 'planning001').status, 'cancelled');
  });

  it('a missing event inside the window is deleted; ones outside it keep their history', async () => {
    const s = await setup({ calendars: [{ id: PERSONAL }] });
    const longRunning = timedEvent('long001', new Date(NOW.getTime() - 40 * DAY_MS), 41 * 24 * 60);
    const inside = timedEvent('inside001', new Date(NOW.getTime() + 5 * DAY_MS));
    const beyond = timedEvent('beyond001', new Date(NOW.getTime() + 100 * DAY_MS));
    const listed = timedEvent('listed001', new Date(NOW.getTime() + 6 * DAY_MS));
    // No sync token comes back, so every run lists in full.
    await sync(
      s,
      fixtureTransport(
        [TOKEN_FIXTURE, eventsPage(PERSONAL, [longRunning, inside, beyond, listed])],
        { now: NOW },
      ),
    );
    const summary = await sync(
      s,
      fixtureTransport([TOKEN_FIXTURE, eventsPage(PERSONAL, [listed])], { now: NOW }),
    );
    assert.deepEqual(summary.counts, counts({ fetched: 1, unchanged: 1, deleted: 1 }));
    const items = await itemsOf(s);
    assert.deepEqual(item(items, PERSONAL, 'inside001').deletedAt, NOW);
    assert.equal(item(items, PERSONAL, 'long001').deletedAt, null, 'started before the window');
    assert.equal(item(items, PERSONAL, 'beyond001').deletedAt, null, 'starts after the window');
    assert.equal(item(items, PERSONAL, 'listed001').deletedAt, null);
    const [container] = await r.containers.list(s.workspaceId, { integrationId: s.integration.id });
    assert.equal(container?.deletedAt, null, 'a windowed listing never sweeps its calendar');
  });

  it('410 Gone on the sync token: the token is dropped, the calendar is listed in full and swept', async () => {
    const s = await setup({ calendars: [{ id: PERSONAL }] });
    const a = timedEvent('a001', new Date(NOW.getTime() + DAY_MS));
    const b = timedEvent('b001', new Date(NOW.getTime() + 2 * DAY_MS));
    await sync(
      s,
      fixtureTransport(
        [TOKEN_FIXTURE, eventsPage(PERSONAL, [a, b], { nextSyncToken: 'FAKE-stale' })],
        { now: NOW },
      ),
    );
    const transport = fixtureTransport(
      [
        TOKEN_FIXTURE,
        {
          request: { url: `${eventsUrl(PERSONAL)}?syncToken=FAKE-stale` },
          response: {
            status: 410,
            body: {
              error: {
                code: 410,
                message: 'Sync token is no longer valid, a full sync is required.',
              },
            },
          },
        },
        eventsPage(PERSONAL, [a], { nextSyncToken: 'FAKE-fresh' }),
      ],
      { now: NOW },
    );
    const summary = await sync(s, transport);
    assert.equal(summary.status, 'succeeded');
    assert.deepEqual(summary.counts, counts({ fetched: 1, unchanged: 1, deleted: 1 }));
    assert.deepEqual(
      transport.calls.map((call) => [
        call.method,
        queryOf(call).get('syncToken'),
        queryOf(call).has('timeMin'),
      ]),
      [
        ['POST', null, false],
        ['GET', 'FAKE-stale', false],
        ['GET', null, true],
      ],
    );
    assert.ok(item(await itemsOf(s), PERSONAL, 'b001').deletedAt instanceof Date);
    const state = await r.states.get(s.workspaceId, s.integration.id, `calendar:${PERSONAL}`);
    assert.deepEqual([state?.syncToken, state?.lastIncrementalAt], ['FAKE-fresh', null]);
  });
});

describe('google_calendar sync: the service-account key (live mode, stub vault, recorded responses)', () => {
  it('signs a calendar.readonly assertion and sends only the bearer token; nothing secret is stored or logged', async () => {
    const account = fakeServiceAccount();
    stubVault(account.secret);
    const s = await setup();
    const transport = await fixtures('v1');
    const summaries: SyncRunSummary[] = [];
    const logs = await captureStderr(async () => {
      summaries.push(await sync(s, transport, 'live'));
    });
    assert.deepEqual(summaries[0]?.counts, counts({ fetched: 13, inserted: 12, failed: 1 }));

    const assertions: string[] = [];
    for (const call of transport.calls) {
      if (call.method === 'GET') {
        assert.equal(call.headers['authorization'], `Bearer ${ACCESS_TOKEN}`);
        continue;
      }
      const assertion = new URLSearchParams(call.body ?? '').get('assertion') ?? '';
      assertions.push(assertion);
      const jwt = decodeJwt(assertion, account.publicKey);
      assert.equal(jwt.verified, true);
      assert.deepEqual(jwt.claims, {
        iss: FAKE_CLIENT_EMAIL,
        scope: 'https://www.googleapis.com/auth/calendar.readonly',
        aud: GOOGLE_TOKEN_URL,
        // Back-dated 60 s for clock skew; one hour at most.
        iat: NOW.getTime() / 1000 - 60,
        exp: NOW.getTime() / 1000 - 60 + 3600,
      });
    }
    assert.equal(assertions.length, 2, 'one exchange per calendar');

    const stored = await everythingStored();
    const keyLine = account.secret.privateKey.split('\n')[1] ?? '';
    assert.ok(keyLine.length > 40);
    for (const secret of [keyLine, 'PRIVATE KEY', ACCESS_TOKEN, ...assertions]) {
      assert.equal(stored.includes(secret), false, 'stored');
      assert.equal(logs.includes(secret), false, 'logged');
    }
  });

  it('a key that cannot sign fails the run as auth_failed before any request, and echoes nothing', async () => {
    stubVault({ clientEmail: FAKE_CLIENT_EMAIL, privateKey: FAKE_UNUSABLE_PEM });
    const s = await setup();
    const transport = await fixtures('v1');
    const summaries: SyncRunSummary[] = [];
    const logs = await captureStderr(async () => {
      summaries.push(await sync(s, transport, 'live'));
    });
    assert.deepEqual(summaries[0]?.error, { code: 'auth_failed', message: 'Reconnect required' });
    assert.deepEqual(transport.calls, []);
    const integration = await r.integrations.findById(s.workspaceId, s.integration.id);
    assert.equal(integration?.status, 'error');
    assert.match(logs, /sync run failed[\s\S]*auth_failed/, 'the failure itself is logged');
    const stored = await everythingStored();
    for (const secret of ['FAKEbm90', 'PRIVATE KEY']) {
      assert.equal(logs.includes(secret), false, 'logged');
      assert.equal(stored.includes(secret), false, 'stored');
    }
  });

  it('a refused token exchange (400 invalid_grant) fails the run as auth_failed; no calendar is read', async () => {
    stubVault(fakeServiceAccount().secret);
    const s = await setup();
    const transport = fixtureTransport(
      [
        {
          request: { method: 'POST', url: GOOGLE_TOKEN_URL },
          response: {
            status: 400,
            body: { error: 'invalid_grant', error_description: 'Invalid JWT Signature.' },
          },
        },
      ],
      { now: NOW },
    );
    const summaries: SyncRunSummary[] = [];
    const logs = await captureStderr(async () => {
      summaries.push(await sync(s, transport, 'live'));
    });
    assert.equal(summaries[0]?.error?.code, 'auth_failed');
    assert.deepEqual(
      transport.calls.map((call) => call.method),
      ['POST'],
    );
    assert.match(logs, /sync run failed[\s\S]*auth_failed/, 'the failure itself is logged');
    for (const echoed of ['invalid_grant', 'Invalid JWT', 'assertion']) {
      assert.equal(logs.includes(echoed), false, echoed);
    }
  });
});

describe('google_calendar sync: bounded listings', () => {
  const tooLarge = (error: unknown): boolean =>
    error instanceof ListingTooLargeError && error.provider === 'google_calendar';

  /** Pages FAKE-p1 … FAKE-p<last>; the last one ends the listing. */
  function pagesUpTo(last: number): (pageToken: string | null) => Record<string, unknown> {
    return (pageToken) => {
      const n = pageToken === null ? 1 : Number(pageToken.slice('FAKE-p'.length));
      return n < last
        ? { nextPageToken: `FAKE-p${String(n + 1)}` }
        : { nextSyncToken: 'FAKE-sync-end' };
    };
  }

  it(`lists a calendar of exactly ${String(MAX_EVENT_PAGES)} pages`, async () => {
    const s = await setup({ calendars: [{ id: PERSONAL }] });
    const transport = generatedCalendar(pagesUpTo(MAX_EVENT_PAGES));
    const { pages, result } = await drain(
      googleCalendarAdapter.fetch(
        contextFor(s, transport, {}, INSTANT),
        `calendar:${PERSONAL}`,
        null,
      ),
    );
    assert.equal(pages.length, MAX_EVENT_PAGES);
    assert.deepEqual(result.nextState, { syncToken: 'FAKE-sync-end' });
  });

  it('a calendar needing one page more fails its resource (listing_too_large), and that page is never asked for', async () => {
    const s = await setup({ calendars: [{ id: PERSONAL }] });
    const transport = generatedCalendar(pagesUpTo(MAX_EVENT_PAGES + 1));
    await assert.rejects(
      drain(
        googleCalendarAdapter.fetch(
          contextFor(s, transport, {}, INSTANT),
          `calendar:${PERSONAL}`,
          null,
        ),
      ),
      tooLarge,
    );
    const gets = transport.requests.filter((request) => request.method === 'GET');
    assert.equal(gets.length, MAX_EVENT_PAGES);
  });

  it('a page token seen twice stops the run: nothing is swept and no state is saved', async () => {
    const s = await setup();
    await sync(s, await fixtures('v1'));
    await r.states.upsert(s.workspaceId, s.integration.id, '__run__', {
      lastFullSyncAt: new Date(NOW.getTime() - 2 * DAY_MS),
    });
    // A full listing of the personal calendar that loops (FAKE-loop → FAKE-loop) and no longer
    // lists any v1 event: had it ended, the sweep would delete all six.
    const transport = fixtureTransport(
      [
        TOKEN_FIXTURE,
        eventsPage(PERSONAL, [timedEvent('loop001', new Date(NOW.getTime() + DAY_MS))], {
          nextPageToken: 'FAKE-loop',
        }),
        {
          request: { url: `${eventsUrl(PERSONAL)}?pageToken=FAKE-loop` },
          response: { body: { kind: 'calendar#events', items: [], nextPageToken: 'FAKE-loop' } },
        },
      ],
      { now: NOW },
    );
    const later = new Date(NOW.getTime() + 60 * 60 * 1000);
    const summary = await sync(s, transport, 'fixtures', later);
    assert.deepEqual(
      [summary.status, summary.error],
      [
        'failed',
        { code: 'listing_too_large', message: 'The provider listing is too large to sync' },
      ],
    );
    assert.deepEqual(
      transport.calls.map((call) => [call.method, queryOf(call).get('pageToken')]),
      [
        ['POST', null],
        ['GET', null],
        ['GET', 'FAKE-loop'],
      ],
    );
    const deleted = [...(await itemsOf(s)).values()].filter((e) => e.deletedAt !== null);
    assert.deepEqual(deleted, [], 'nothing swept');
    const state = await r.states.get(s.workspaceId, s.integration.id, `calendar:${PERSONAL}`);
    assert.deepEqual(
      [state?.syncToken, state?.lastFullSyncAt],
      ['FAKE-sync-personal-v1', NOW],
      'the state of the v1 run, untouched',
    );
  });
});

describe('google_calendar test()', () => {
  it('reads every configured calendar and is labelled by the first one', async () => {
    const s = await setup();
    const transport = await fixtures('v1');
    const result = await googleCalendarAdapter.test?.(contextFor(s, transport, {}));
    // Fixtures mode has no secret, so no service account to name.
    assert.deepEqual(result, { accountLabel: 'Shalev (demo)' });
    assert.deepEqual(
      transport.calls.map((call) => `${call.method} ${call.url}`),
      [
        `POST ${GOOGLE_TOKEN_URL}`,
        `GET ${EVENTS_API}/personal%40example.invalid`,
        `GET ${EVENTS_API}/college%40example.invalid`,
      ],
    );
  });

  it("reports the service account's client email as the account id", async () => {
    const s = await setup();
    const result = await googleCalendarAdapter.test?.(
      contextFor(s, await fixtures('v1'), fakeServiceAccount().secret),
    );
    assert.deepEqual(result, { accountLabel: 'Shalev (demo)', accountId: FAKE_CLIENT_EMAIL });
  });

  it('with no calendar configured there is nothing to test: not_found, nothing sent', async () => {
    const s = await setup({ calendars: [] });
    const transport = await fixtures('v1');
    await assert.rejects(
      googleCalendarAdapter.test?.(contextFor(s, transport, {})) ?? Promise.resolve(),
      (error: unknown) => error instanceof ProviderHttpError && error.code === 'not_found',
    );
    assert.deepEqual(transport.calls, []);
  });
});

describe('google_calendar: the default fixture set', () => {
  it('a fixtures-mode run without a transport replays src/sync/fixtures/google_calendar/v1', async () => {
    const s = await setup();
    const { runIntegrationSync } = await import('../runSync.js');
    const summary = await runIntegrationSync(s.integration.id, {
      trigger: 'manual',
      mode: 'fixtures',
    });
    assert.deepEqual(summary.counts, counts({ fetched: 13, inserted: 12, failed: 1 }));
  });
});
