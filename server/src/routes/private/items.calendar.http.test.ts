/**
 * Calendar events and recurring to-dos over HTTP (Phase 4a), against the mock Google with a real
 * OAuth grant:
 * - an event's edit is split like any mirrored item's: its title and time go to Google through
 *   CalendarProvider#updateEvent (its owner only, read & write; the time given whole, a new start
 *   keeping the duration and the event's own all-day form), guests need `notifyGuests`, and what
 *   Google lacks (a priority, a due date) is kept as an override with nothing sent;
 * - a recurring to-do (`POST …/items` with `recurrence`) is created in the workspace's primary
 *   calendar only, by its integration's owner while it is read & write, and answered at once as
 *   its event item; no local to-do is made. Every refusal sends Google nothing but reads.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type * as Models from '../../models/index.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import {
  pointAppAtMockGoogle,
  startMockGoogle,
  type MockGoogle,
} from '../../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000077', email: 'alice.items@example.test' };
const TZ = 'Asia/Jerusalem';
const WEEKLY = ['RRULE:FREQ=WEEKLY;BYDAY=MO'];

type Json = Record<string, unknown>;

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
const token = { owner: '', editor: '' };
const ids = { owner: '', editor: '' };
let wid = '';
let iid = '';

const W = (): string => `/api/private/workspaces/${wid}`;
const call = (
  who: keyof typeof token,
  method: string,
  path: string,
  body?: unknown,
): Promise<ApiResponse> =>
  api.call(method, `${W()}${path}`, { token: token[who], ...(body === undefined ? {} : { body }) });
const data = (res: ApiResponse): Json => (res.body?.['data'] ?? {}) as Json;

/** What Google was sent that is not a read (a token exchange included). */
const writes = (): string[] =>
  mock
    .requests()
    .filter((request) => request.method !== 'GET')
    .map((request) => `${request.method} ${request.path}`);
const since = (before: readonly string[]): string[] => writes().slice(before.length);
const calendarWrites = (list: readonly string[]): string[] =>
  list.filter((line) => !line.endsWith('/token'));

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_items_calendar_http');
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../../models/index.js');
  for (const who of ['owner', 'editor'] as const) {
    token[who] = (await api.login(`items-cal-${who}@example.test`)).token;
    ids[who] = (data(await api.call('GET', '/api/private/me', { token: token[who] }))['id'] ??
      '') as string;
  }
  wid = (
    await (
      await models.getWorkspaceRepository()
    ).create({
      name: 'Calendar items',
      slug: `cal-items-${randomUUID().slice(0, 8)}`,
      ownerId: ids.owner,
      settings: { timezone: TZ },
    })
  ).id;
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: ids.owner, role: 'owner' });
  await memberships.create(wid, { userId: ids.editor, role: 'editor' });
  iid = await connect();
  const switched = await call('owner', 'PATCH', `/integrations/${iid}`, { mode: 'read_write' });
  assert.equal(switched.status, 200, switched.text);
  // Shared: the editor sees its events (and is not their integration's owner).
  const { shareIntegrations } = await import('../../testing/integrationFixtures.js');
  await shareIntegrations(wid, ids.owner, [iid]);
});

after(async () => {
  await api.stop();
  await mock.close();
  guard.restore();
});

/** Google Calendar connected by the owner through the OAuth flow; its id. */
async function connect(): Promise<string> {
  const started = await fetch(`${api.baseUrl}${W()}/integrations/google-calendar/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token.owner}` },
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
  return connected[1] ?? '';
}

/** An event "in Google" on Alice's calendar, and its item here (as a sync writes it). */
async function pulled(summary: string, props: Json = {}): Promise<{ eventId: string; id: string }> {
  const added = mock.addEvent(ALICE.email, {
    summary,
    start: { dateTime: '2026-11-24T07:00:00Z' },
    end: { dateTime: '2026-11-24T07:30:00Z' },
  });
  const items = await models.getItemRepository();
  const integration = await (await models.getIntegrationRepository()).findById(wid, iid);
  assert.ok(integration);
  const account = { provider: 'google_calendar' as const, accountId: integration.accountId };
  const externalId = `${ALICE.email}:${added.id}`;
  await items.bulkUpsert(wid, [
    {
      integrationId: iid,
      kind: 'event',
      topicId: null,
      title: summary,
      status: 'open',
      statusRaw: 'confirmed',
      startAt: new Date('2026-11-24T07:00:00Z'),
      endAt: new Date('2026-11-24T07:30:00Z'),
      allDay: false,
      props: { calendarId: ALICE.email, eventId: added.id, guestsCount: 0, ...props },
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
  const stored = await items.findBySource(wid, { ...account, integrationId: iid }, externalId);
  assert.ok(stored);
  return { eventId: added.id, id: stored.id };
}

describe('an event’s edit, split', () => {
  it('its owner moves it: one PATCH, the duration and its timed form kept; a priority stays here', async () => {
    const { eventId, id } = await pulled('Dentist');
    const before = writes();
    const res = await call('owner', 'PATCH', `/items/${id}`, {
      startAt: '2026-11-25T08:00:00.000Z',
      priority: 2,
    });
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(calendarWrites(since(before)), [
      `PATCH /calendar/v3/calendars/${encodeURIComponent(ALICE.email)}/events/${eventId}`,
    ]);
    const atGoogle = mock.events(ALICE.email).find((entry) => entry.id === eventId);
    assert.equal((atGoogle?.start as Json | undefined)?.['dateTime'], '2026-11-25T08:00:00.000Z');
    assert.equal((atGoogle?.end as Json | undefined)?.['dateTime'], '2026-11-25T08:30:00.000Z');
    const item = data(res);
    assert.deepEqual(
      [item['startAt'], item['endAt'], item['allDay'], item['priority']],
      ['2026-11-25T08:00:00.000Z', '2026-11-25T08:30:00.000Z', false, 2],
    );
    const editing = item['editing'] as Json;
    assert.deepEqual(
      [editing['providerFields'], editing['overridableFields'], editing['needsGuestNotice']],
      [['title', 'startAt', 'endAt'], ['status', 'dueAt', 'priority'], false],
    );
  });

  it('an event with other guests: 409 event_has_guests, then sent with sendUpdates', async () => {
    const { eventId, id } = await pulled('Team sync', { guestsCount: 3 });
    const before = writes();
    const refused = await call('owner', 'PATCH', `/items/${id}`, { title: 'Team sync (moved)' });
    assert.equal(refused.status, 409, refused.text);
    assert.equal(refused.body?.['code'], 'event_has_guests');
    assert.deepEqual(calendarWrites(since(before)), []);
    const view = data(await call('owner', 'GET', `/items/${id}`));
    assert.equal((view['editing'] as Json)['needsGuestNotice'], true);
    const sentWith = await call('owner', 'PATCH', `/items/${id}`, {
      title: 'Team sync (moved)',
      notifyGuests: true,
    });
    assert.equal(sentWith.status, 200, sentWith.text);
    const patched = mock
      .requests()
      .filter((request) => request.method === 'PATCH' && request.path.endsWith(eventId));
    assert.match(patched.at(-1)?.query ?? '', /sendUpdates=all/);
  });

  it('a timed event can’t be made all day by an override: its time keeps its own form (400)', async () => {
    const { id } = await pulled('Standup');
    const before = writes();
    const refused = await call('owner', 'PATCH', `/items/${id}`, {
      dueAt: '2026-11-26T00:00:00.000Z',
      allDay: true,
    });
    assert.equal(refused.status, 400, refused.text);
    const alone = await call('owner', 'PATCH', `/items/${id}`, { allDay: true });
    assert.equal(alone.status, 400, alone.text);
    // A due date alone is kept (Google has none) and leaves its timed form as it is.
    const kept = await call('owner', 'PATCH', `/items/${id}`, {
      dueAt: '2026-11-26T00:00:00.000Z',
    });
    assert.equal(kept.status, 200, kept.text);
    assert.equal(data(kept)['allDay'], false);
    assert.deepEqual(since(before), []);
  });

  it('anyone else: 403 for its time, with nothing sent; what Google lacks is still theirs to keep', async () => {
    const { id } = await pulled('Gym');
    const before = writes();
    const refused = await call('editor', 'PATCH', `/items/${id}`, {
      startAt: '2026-11-26T08:00:00.000Z',
      endAt: '2026-11-26T09:00:00.000Z',
    });
    assert.equal(refused.status, 403, refused.text);
    assert.equal(refused.body?.['code'], 'integration_not_owner');
    const kept = await call('editor', 'PATCH', `/items/${id}`, { status: 'done' });
    assert.equal(kept.status, 200, kept.text);
    assert.equal(data(kept)['status'], 'done');
    assert.deepEqual(since(before), []);
  });
});

describe('a recurring to-do', () => {
  const recurring = (who: keyof typeof token, extra: Json = {}): Promise<ApiResponse> =>
    call(who, 'POST', '/items', {
      title: 'Weekly review',
      dueAt: '2026-11-23T07:00:00.000Z',
      recurrence: WEEKLY,
      ...extra,
    });

  it('needs the workspace’s primary calendar: 409 primary_calendar_unset, nothing sent', async () => {
    const before = writes();
    const res = await recurring('owner');
    assert.equal(res.status, 409, res.text);
    assert.equal(res.body?.['code'], 'primary_calendar_unset');
    assert.deepEqual(since(before), []);
  });

  it('is created there by its integration’s owner, and answered as its event item at once', async () => {
    const set = await call('owner', 'PUT', '/primary-calendar', {
      integrationId: iid,
      calendarId: ALICE.email,
    });
    assert.equal(set.status, 200, set.text);
    const locals = async (): Promise<number> =>
      (
        await (
          await models.getItemRepository()
        ).aggregate(wid, [{ $match: { 'source.provider': 'local' } }])
      ).length;
    const localsBefore = await locals();
    const before = writes();
    const res = await recurring('owner', { idempotencyKey: 'weekly-review', priority: 3 });
    assert.equal(res.status, 201, res.text);
    assert.deepEqual(calendarWrites(since(before)), [
      `POST /calendar/v3/calendars/${encodeURIComponent(ALICE.email)}/events`,
    ]);
    const item = data(res);
    assert.equal(item['kind'], 'event');
    assert.equal((item['source'] as Json)['provider'], 'google_calendar');
    assert.deepEqual((item['props'] as Json)['recurrence'], ['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    assert.equal(item['priority'], 3, 'kept as an override: Google has no priority');
    const atGoogle = mock.events(ALICE.email).find((entry) => entry.summary === 'Weekly review');
    assert.deepEqual(atGoogle?.recurrence, ['RRULE:FREQ=WEEKLY;BYDAY=MO']);
    assert.equal(await locals(), localsBefore, 'no local to-do is made');
    const [audit] = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'provider.create' }, 1);
    assert.deepEqual(
      [audit?.targetId, (audit?.meta as Json | undefined)?.['result']],
      [iid, 'created'],
    );
  });

  it('anyone but its owner: 403; a bad rule, no due date or a container: 400; nothing sent', async () => {
    const before = writes();
    const notOwner = await recurring('editor');
    assert.equal(notOwner.status, 403, notOwner.text);
    assert.equal(notOwner.body?.['code'], 'integration_not_owner');
    const badRule = await recurring('owner', { recurrence: ['RRULE:FREQ=HOURLY'] });
    assert.equal(badRule.status, 400, badRule.text);
    const twoRules = await recurring('owner', {
      recurrence: ['RRULE:FREQ=DAILY', 'RRULE:FREQ=WEEKLY'],
    });
    assert.equal(twoRules.status, 400, twoRules.text);
    const noDue = await recurring('owner', { dueAt: null });
    assert.equal(noDue.status, 400, noDue.text);
    assert.equal(noDue.body?.['code'], 'needs_due_date');
    const container = await recurring('owner', { containerId: 'c-1' });
    assert.equal(container.status, 400, container.text);
    assert.deepEqual(calendarWrites(since(before)), []);
  });

  it('a retry with the same key is the same event: 200, nothing sent, no place taken', async () => {
    const before = writes();
    const again = await recurring('owner', { idempotencyKey: 'weekly-review', priority: 3 });
    assert.equal(again.status, 200, again.text);
    assert.deepEqual(calendarWrites(since(before)), []);
    assert.equal(
      mock.events(ALICE.email).filter((entry) => entry.summary === 'Weekly review').length,
      1,
    );
    const audits = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'provider.create' }, 10);
    assert.equal(audits.length, 1, 'one create, audited once');
  });

  it('the workspace calendar is read from then on, so its next sync keeps the event', async () => {
    // A connection whose read calendars do not hold the workspace calendar.
    await (
      await models.getIntegrationRepository()
    ).update(wid, iid, {
      config: { calendars: [] },
    });
    const res = await recurring('owner', { title: 'Monthly review', idempotencyKey: 'monthly' });
    assert.equal(res.status, 201, res.text);
    const stored = await (await models.getIntegrationRepository()).findById(wid, iid);
    const calendars = (stored?.config as { calendars?: { id: string }[] }).calendars ?? [];
    assert.deepEqual(
      calendars.map((calendar) => calendar.id),
      [ALICE.email],
    );
    const [entry] = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'integration.update' }, 1);
    assert.deepEqual(entry?.meta, { changed: ['config'], reason: 'primary_calendar_read' });
  });

  it('made at Google but not stored here: 409 created_not_stored with details.written', async () => {
    const { MirroredItem } = await import('../../classes/item/index.js');
    const store = MirroredItem.store.bind(MirroredItem);
    const failing: typeof MirroredItem.store = (): Promise<never> =>
      Promise.reject(new Error('database down'));
    MirroredItem.store = failing;
    try {
      const res = await recurring('owner', {
        title: 'Quarterly review',
        idempotencyKey: 'q1',
        priority: 2,
      });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body?.['code'], 'created_not_stored');
      assert.deepEqual(res.body['details'], { written: ['event'] });
      assert.ok(mock.events(ALICE.email).some((entry) => entry.summary === 'Quarterly review'));
    } finally {
      MirroredItem.store = store;
    }
    // The retry with the same key is the same event (Google had it): stored now, nothing new made.
    const before = writes();
    const again = await recurring('owner', {
      title: 'Quarterly review',
      idempotencyKey: 'q1',
      priority: 2,
    });
    assert.equal(again.status, 200, again.text);
    assert.equal(data(again)['kind'], 'event');
    assert.equal(data(again)['priority'], 2, 'the retry still applies the request’s priority');
    assert.equal(
      mock.events(ALICE.email).filter((entry) => entry.summary === 'Quarterly review').length,
      1,
    );
    // The one insert, which Google answers 409 (it has the event): nothing new is made.
    assert.deepEqual(calendarWrites(since(before)), [
      `POST /calendar/v3/calendars/${encodeURIComponent(ALICE.email)}/events`,
    ]);
  });

  it('the read calendar failing after Google created the event: 409 created_not_stored, not a 500', async () => {
    const { GoogleCalendarIntegration } =
      await import('../../classes/integration/providers/GoogleCalendarIntegration.js');
    const proto = GoogleCalendarIntegration.prototype;
    const original: unknown = Reflect.get(proto, 'ensureReads');
    const failing = (): Promise<boolean> => Promise.reject(new Error('database down'));
    Reflect.set(proto, 'ensureReads', failing);
    try {
      const res = await recurring('owner', { title: 'Yearly review', idempotencyKey: 'y1' });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body?.['code'], 'created_not_stored');
      assert.deepEqual(res.body['details'], { written: ['event'] });
      assert.ok(mock.events(ALICE.email).some((entry) => entry.summary === 'Yearly review'));
    } finally {
      Reflect.set(proto, 'ensureReads', original);
    }
  });

  it('a create Google refuses or leaves unanswered carries a code, nothing stored', async () => {
    const cases: { status: number; http: number; code: string }[] = [
      { status: 401, http: 409, code: 'provider_refused' },
      { status: 403, http: 409, code: 'provider_refused' },
      { status: 503, http: 502, code: 'provider_no_answer' },
    ];
    for (const refusal of cases) {
      mock.failNextWrite(refusal.status);
      const res = await recurring('owner', {
        title: `Refused ${String(refusal.status)}`,
        idempotencyKey: `refused-${String(refusal.status)}`,
      });
      assert.equal(res.status, refusal.http, res.text);
      assert.equal(res.body?.['code'], refusal.code, res.text);
    }
  });

  it('a retry that finds the event at Google stores Google’s version, not the request’s', async () => {
    const { MirroredItem } = await import('../../classes/item/index.js');
    const store = MirroredItem.store.bind(MirroredItem);
    MirroredItem.store = (): Promise<never> => Promise.reject(new Error('database down'));
    try {
      const first = await recurring('owner', { title: 'As first sent', idempotencyKey: 'i2' });
      assert.equal(first.body?.['code'], 'created_not_stored', first.text);
    } finally {
      MirroredItem.store = store;
    }
    // Google's event changed meanwhile (its summary and its rule).
    const atGoogle = mock.events(ALICE.email).find((entry) => entry.summary === 'As first sent');
    assert.ok(atGoogle);
    atGoogle.summary = 'Changed at Google';
    atGoogle.recurrence = ['RRULE:FREQ=DAILY'];
    const again = await recurring('owner', { title: 'As retried', idempotencyKey: 'i2' });
    assert.equal(again.status, 200, again.text);
    assert.equal(data(again)['title'], 'Changed at Google');
    assert.deepEqual((data(again)['props'] as Json)['recurrence'], ['RRULE:FREQ=DAILY']);
  });

  it('a retry whose read-back fails stores nothing: 409 created_not_stored', async () => {
    const { MirroredItem } = await import('../../classes/item/index.js');
    const { GoogleCalendarIntegration } =
      await import('../../classes/integration/providers/GoogleCalendarIntegration.js');
    const store = MirroredItem.store.bind(MirroredItem);
    MirroredItem.store = (): Promise<never> => Promise.reject(new Error('database down'));
    try {
      const first = await recurring('owner', { title: 'Read back', idempotencyKey: 'i2b' });
      assert.equal(first.body?.['code'], 'created_not_stored', first.text);
    } finally {
      MirroredItem.store = store;
    }
    const proto = GoogleCalendarIntegration.prototype;
    const original: unknown = Reflect.get(proto, 'readEvent');
    Reflect.set(
      proto,
      'readEvent',
      (): Promise<never> => Promise.reject(new Error('Google is down')),
    );
    try {
      const res = await recurring('owner', { title: 'Read back', idempotencyKey: 'i2b' });
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body?.['code'], 'created_not_stored');
      assert.deepEqual(res.body['details'], { written: ['event'] });
    } finally {
      Reflect.set(proto, 'readEvent', original);
    }
  });

  it('while its integration is read-only: 409 integration_read_only, nothing sent', async () => {
    const readOnly = await call('owner', 'PATCH', `/integrations/${iid}`, { mode: 'read' });
    assert.equal(readOnly.status, 200, readOnly.text);
    try {
      const before = writes();
      const res = await recurring('owner');
      assert.equal(res.status, 409, res.text);
      assert.equal(res.body?.['code'], 'integration_read_only');
      assert.deepEqual(since(before), []);
    } finally {
      await call('owner', 'PATCH', `/integrations/${iid}`, { mode: 'read_write' });
    }
  });

  it('a retry that finds the event cancelled at Google: 404 provider_item_missing', async () => {
    const { MirroredItem } = await import('../../classes/item/index.js');
    const store = MirroredItem.store.bind(MirroredItem);
    MirroredItem.store = (): Promise<never> => Promise.reject(new Error('database down'));
    try {
      const first = await recurring('owner', { title: 'Deleted later', idempotencyKey: 'i2c' });
      assert.equal(first.body?.['code'], 'created_not_stored', first.text);
    } finally {
      MirroredItem.store = store;
    }
    const atGoogle = mock.events(ALICE.email).find((entry) => entry.summary === 'Deleted later');
    assert.ok(atGoogle);
    atGoogle.status = 'cancelled';
    const again = await recurring('owner', { title: 'Deleted later', idempotencyKey: 'i2c' });
    assert.equal(again.status, 404, again.text);
    assert.equal(again.body?.['code'], 'provider_item_missing');
  });

  it('a read-back Google answers 410 (gone): 404 provider_item_missing; a 404 (maybe moved): created_not_stored', async () => {
    const { MirroredItem } = await import('../../classes/item/index.js');
    const store = MirroredItem.store.bind(MirroredItem);
    for (const [key, status, code, httpStatus] of [
      ['i2g', 410, 'provider_item_missing', 404],
      ['i2h', 404, 'created_not_stored', 409],
    ] as const) {
      MirroredItem.store = (): Promise<never> => Promise.reject(new Error('database down'));
      try {
        const first = await recurring('owner', { title: `Read ${key}`, idempotencyKey: key });
        assert.equal(first.body?.['code'], 'created_not_stored', first.text);
      } finally {
        MirroredItem.store = store;
      }
      mock.failNextRead(status);
      const again = await recurring('owner', { title: `Read ${key}`, idempotencyKey: key });
      assert.equal(again.status, httpStatus, again.text);
      assert.equal(again.body?.['code'], code);
    }
  });

  it('a replay of the same key never puts its topic or priority back over a later edit', async () => {
    const first = await recurring('owner', {
      title: 'Replayed',
      priority: 1,
      idempotencyKey: 'i2r',
    });
    assert.equal(first.status, 201, first.text);
    const id = String(data(first)['id']);
    const edited = await call('owner', 'PATCH', `/items/${id}`, { priority: 4 });
    assert.equal(edited.status, 200, edited.text);
    const replay = await recurring('owner', {
      title: 'Replayed',
      priority: 1,
      idempotencyKey: 'i2r',
    });
    assert.equal(replay.status, 200, replay.text);
    assert.equal(data(replay)['priority'], 4, 'the later edit stays');
  });

  it('a topic or priority that failed to store: created_not_stored, and the same retry completes it', async () => {
    const { Item } = await import('../../classes/item/index.js');
    const original: unknown = Reflect.get(Item.prototype, 'storeOverlay');
    Reflect.set(
      Item.prototype,
      'storeOverlay',
      (): Promise<never> => Promise.reject(new Error('database down')),
    );
    try {
      const first = await recurring('owner', {
        title: 'Needs its priority',
        priority: 3,
        idempotencyKey: 'i2d',
      });
      assert.equal(first.status, 409, first.text);
      assert.equal(first.body?.['code'], 'created_not_stored');
    } finally {
      Reflect.set(Item.prototype, 'storeOverlay', original);
    }
    const again = await recurring('owner', {
      title: 'Needs its priority',
      priority: 3,
      idempotencyKey: 'i2d',
    });
    assert.equal(again.status, 200, again.text);
    assert.equal(data(again)['priority'], 3);
  });

  it('readEvent is its owner’s: anyone else is refused', async () => {
    const { Integration } = await import('../../classes/integration/index.js');
    const { callerFor } = await import('../../testing/workspaceFixtures.js');
    const integration = await Integration.forWorker(iid);
    assert.ok(integration !== null && 'readEvent' in integration);
    const other = await callerFor(wid, ids.editor);
    const mine = await callerFor(wid, ids.owner);
    await assert.rejects(
      (
        integration as unknown as { readEvent(c: unknown, a: string, b: string): Promise<unknown> }
      ).readEvent(other, ALICE.email, 'whatever'),
      /Not found|owner/i,
    );
    const own = integration as unknown as {
      readEvent(c: unknown, a: string, b: string): Promise<unknown>;
    };
    // The owner gets past the owner check to Google, which has no such event: a 404 is thrown
    // (only a 410 reads as gone).
    await assert.rejects(own.readEvent(mine, ALICE.email, 'whatever'), /answered 404/);
  });
});

describe('the primary calendar is always a read calendar', () => {
  const calendarIds = async (): Promise<string[]> => {
    const stored = await (await models.getIntegrationRepository()).findById(wid, iid);
    return ((stored?.config as { calendars?: { id: string }[] }).calendars ?? []).map(
      (calendar) => calendar.id,
    );
  };

  it('setting it adds the calendar to the integration’s reads, audited, with no Google write', async () => {
    await (await models.getIntegrationRepository()).update(wid, iid, { config: { calendars: [] } });
    const before = writes();
    const set = await call('owner', 'PUT', '/primary-calendar', {
      integrationId: iid,
      calendarId: ALICE.email,
    });
    assert.equal(set.status, 200, set.text);
    assert.deepEqual(await calendarIds(), [ALICE.email]);
    assert.deepEqual(calendarWrites(since(before)), []);
    const [entry] = await (
      await models.getAuditLogRepository()
    ).list(wid, { action: 'integration.update' }, 1);
    assert.deepEqual(entry?.meta, { changed: ['config'], reason: 'primary_calendar_read' });
  });

  it('the owner’s own update of the read calendars keeps it, as read', async () => {
    const res = await call('owner', 'PATCH', `/integrations/${iid}`, {
      config: { calendars: [] },
    });
    assert.equal(res.status, 200, res.text);
    const stored = await (await models.getIntegrationRepository()).findById(wid, iid);
    assert.deepEqual((stored?.config as { calendars?: unknown }).calendars, [
      { id: ALICE.email, mode: 'read' },
    ]);
  });

  it('a legacy plain-id entry counts as read: nothing is added or audited', async () => {
    const integrations = await models.getIntegrationRepository();
    await integrations.update(wid, iid, { config: { calendars: [ALICE.email] } });
    const set = await call('owner', 'PUT', '/primary-calendar', {
      integrationId: iid,
      calendarId: ALICE.email,
    });
    assert.equal(set.status, 200, set.text);
    const stored = await integrations.findById(wid, iid);
    assert.deepEqual((stored?.config as { calendars?: unknown }).calendars, [ALICE.email]);
    const kept = await call('owner', 'PATCH', `/integrations/${iid}`, {
      config: { calendars: [] },
    });
    assert.equal(kept.status, 200, kept.text);
  });

  it('a connection that reads 50 calendars refuses one more: 400, nothing stored', async () => {
    const integrations = await models.getIntegrationRepository();
    const full = Array.from({ length: 50 }, (_, index) => ({
      id: `full-${String(index)}@example.test`,
      mode: 'read',
    }));
    await integrations.update(wid, iid, { config: { calendars: full } });
    const before = await (await models.getWorkspaceRepository()).findById(wid);
    const set = await call('owner', 'PUT', '/primary-calendar', {
      integrationId: iid,
      calendarId: ALICE.email,
    });
    assert.equal(set.status, 400, set.text);
    assert.match(String(set.body?.['message']), /reads 50 calendars, the most/);
    const after = await (await models.getWorkspaceRepository()).findById(wid);
    assert.deepEqual(after?.settings, before?.settings, 'the primary calendar is unchanged');
    const stored = await integrations.findById(wid, iid);
    assert.equal((stored?.config as { calendars?: unknown[] }).calendars?.length, 50);
    // A config update that leaves the primary out of a full list is refused the same way.
    const patched = await call('owner', 'PATCH', `/integrations/${iid}`, {
      config: { calendars: full },
    });
    assert.equal(patched.status, 400, patched.text);
    // A recurring create there: Google made it, it is not stored (R3).
    const created = await call('owner', 'POST', '/items', {
      title: 'Full list',
      dueAt: '2026-11-23T07:00:00.000Z',
      recurrence: WEEKLY,
      idempotencyKey: 'full-list',
    });
    assert.equal(created.status, 409, created.text);
    assert.equal(created.body?.['code'], 'created_not_stored');
    await integrations.update(wid, iid, { config: { calendars: [] } });
  });
});
