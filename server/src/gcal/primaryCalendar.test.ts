/**
 * The workspace's primary calendar, end to end against the mock Google (plan Addendum A2): only a
 * workspace owner sets it, among the Google Calendar integrations they own that are read & write,
 * on a calendar the account can write, or a new one TodoList creates (read, recorded as its own).
 * The push goes there and nowhere else (a moved primary calendar moves the events); a deleted
 * to-do's event goes at once; read-only suspends it; "Also remove everything TodoList added"
 * deletes the pushed events and the calendars TodoList created (only those, and only when empty
 * of anything else) before the disconnect, which suspends it as disconnected. Audit entries
 * carry no calendar id or name.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type * as Models from '../models/index.js';
import { startApiHarness, type ApiHarness } from '../testing/apiHarness.js';
import {
  MOCK_HOLIDAYS_CALENDAR,
  pointAppAtMockGoogle,
  startMockGoogle,
  type MockGoogle,
} from '../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';
import { eventIdFor } from './diff.js';

forceSyncModeForTests('fixtures');

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000055', email: 'alice.primary@example.test' };

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
let owner: string;
let editor: string;
let ownerId: string;
let editorId: string;
let wid: string;
let iid = '';
let created = '';
let spare = '';
let shared = '';
let other = '';
const items: Record<string, string> = {};

const W = (): string => `/api/private/workspaces/${wid}`;
const as = (
  token: string,
  method: string,
  path: string,
  body?: unknown,
): ReturnType<ApiHarness['call']> =>
  api.call(method, `${W()}${path}`, { token, ...(body === undefined ? {} : { body }) });

/** What Google was sent that is not a read, as `METHOD path`. */
const writes = (): string[] =>
  mock
    .requests()
    .filter((request) => request.method !== 'GET' && request.path !== '/token')
    .map((request) => `${request.method} ${request.path}`);
const since = (before: readonly string[]): string[] => writes().slice(before.length);
const calendarPath = (id: string): string => `/calendar/v3/calendars/${encodeURIComponent(id)}`;

async function audits(action: string): Promise<Json[]> {
  return (await (await models.getAuditLogRepository()).list(wid, { action }, 20)).map(
    (entry) => entry.meta,
  );
}

async function connect(workspaceId: string = wid): Promise<string> {
  const base = `/api/private/workspaces/${workspaceId}`;
  const started = await fetch(`${api.baseUrl}${base}/integrations/google-calendar/oauth/start`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${owner}` },
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
  const id = /connected=([0-9a-f-]{36})/.exec(landed.headers.get('location') ?? '')?.[1];
  assert.ok(id !== undefined, landed.headers.get('location') ?? '');
  return id;
}

async function setMode(mode: 'read' | 'read_write'): Promise<void> {
  const switched = await as(owner, 'PATCH', `/integrations/${iid}`, { mode });
  assert.equal(switched.status, 200, switched.text);
}

async function push(): Promise<void> {
  const pushed = await as(owner, 'POST', '/gcal-sync', { integrationId: iid, confirm: true });
  assert.equal(pushed.status, 202, pushed.text);
}

async function todo(title: string, body: Json): Promise<string> {
  const made = await as(owner, 'POST', '/items', { title, ...body });
  assert.equal(made.status, 201, made.text);
  return data(made.body)['id'] as string;
}

const eventIds = (calendarId: string): string[] =>
  mock
    .events(calendarId)
    .map((event) => event.id)
    .sort();

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_gcal_primary_calendar');
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../models/index.js');
  owner = (await api.login('primary-owner@example.test')).token;
  editor = (await api.login('primary-editor@example.test')).token;
  const idOf = async (token: string): Promise<string> =>
    data((await api.call('GET', '/api/private/me', { token })).body)['id'] as string;
  ownerId = await idOf(owner);
  editorId = await idOf(editor);
  wid = (
    await (
      await models.getWorkspaceRepository()
    ).create({ name: 'Primary', slug: `primary-${randomUUID().slice(0, 8)}`, ownerId })
  ).id;
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: ownerId, role: 'owner' });
  await memberships.create(wid, { userId: editorId, role: 'editor' });
  iid = await connect();
});

after(async () => {
  await api.stop();
  await mock.close();
  guard.restore();
});

describe('choosing the primary calendar', () => {
  it('none at first: every member sees it unset', async () => {
    for (const token of [owner, editor]) {
      const shown = await as(token, 'GET', '/primary-calendar');
      assert.equal(shown.status, 200, shown.text);
      assert.deepEqual(data(shown.body), {
        state: 'unset',
        reason: null,
        mine: false,
        integrationId: null,
        calendarId: null,
      });
    }
  });

  it('refused: an editor (403), read-only (409), another member’s integration (404), a calendar it can’t write (400)', async () => {
    const before = writes();
    const byEditor = await as(editor, 'PUT', '/primary-calendar', {
      integrationId: iid,
      calendarId: ALICE.email,
    });
    assert.equal(byEditor.status, 403, byEditor.text);
    const readOnly = await as(owner, 'PUT', '/primary-calendar', {
      integrationId: iid,
      calendarId: ALICE.email,
    });
    assert.equal(readOnly.status, 409, readOnly.text);
    assert.equal(readOnly.body?.['code'], 'integration_read_only');

    await setMode('read_write');
    const theirs = await (
      await models.getIntegrationRepository()
    ).create(wid, {
      connectedBy: editorId,
      provider: 'google_calendar',
      accountId: 'editor-google',
      label: 'Editor Google',
      authMethod: 'oauth',
      topicId: null,
      mode: 'read_write',
      config: { calendars: [] },
      status: 'active',
      lastError: null,
    });
    const notMine = await as(owner, 'PUT', '/primary-calendar', {
      integrationId: theirs.id,
      calendarId: 'editor@example.test',
    });
    assert.equal(notMine.status, 404, notMine.text);
    for (const calendarId of [MOCK_HOLIDAYS_CALENDAR, 'nobody@example.test']) {
      const refused = await as(owner, 'PUT', '/primary-calendar', {
        integrationId: iid,
        calendarId,
      });
      assert.equal(refused.status, 400, refused.text);
    }
    const malformed = await as(owner, 'PUT', '/primary-calendar', {
      integrationId: iid,
      calendarId: ALICE.email,
      extra: true,
    });
    assert.equal(malformed.status, 400, malformed.text);
    assert.deepEqual(since(before), []);
    assert.deepEqual(await audits('workspace.primary_calendar'), []);
  });

  it('the owner chooses a calendar of their own read & write integration; members see only that one is set', async () => {
    const chosen = await as(owner, 'PUT', '/primary-calendar', {
      integrationId: iid,
      calendarId: ALICE.email,
    });
    assert.equal(chosen.status, 200, chosen.text);
    assert.deepEqual(data(chosen.body), {
      state: 'active',
      reason: null,
      mine: true,
      integrationId: iid,
      calendarId: ALICE.email,
    });
    const seen = await as(editor, 'GET', '/primary-calendar');
    assert.deepEqual(data(seen.body), {
      state: 'active',
      reason: null,
      mine: false,
      integrationId: null,
      calendarId: null,
    });
    assert.deepEqual(await audits('workspace.primary_calendar'), [
      { integrationId: iid, created: false },
    ]);
  });
});

describe('the push goes to the primary calendar', () => {
  it('pushes every dated item the owner may see: due, planned, and a member’s shared to-do', async () => {
    items['due'] = await todo('Dentist', {
      dueAt: new Date(Date.now() + 2 * 86_400_000).toISOString(),
    });
    items['planned'] = await todo('Plan the trip', {});
    const planned = await as(owner, 'PATCH', `/items/${items['planned']}/overlay`, {
      plannedAt: new Date(Date.now() + 3 * 86_400_000).toISOString().slice(0, 10),
    });
    assert.equal(planned.status, 200, planned.text);
    assert.match(
      String((data(planned.body)['overlay'] as Json)['plannedAt']),
      /^\d{4}-\d{2}-\d{2}$/,
    );
    const bad = await as(owner, 'PATCH', `/items/${items['planned']}/overlay`, {
      plannedAt: '2026-02-30',
    });
    assert.equal(bad.status, 400, bad.text);
    const shared = await as(editor, 'POST', '/items', {
      title: 'The editor’s shared to-do',
      dueAt: new Date(Date.now() + 4 * 86_400_000).toISOString(),
    });
    assert.equal(shared.status, 201, shared.text);
    items['shared'] = data(shared.body)['id'] as string;
    await todo('Someday', {});

    await push();
    assert.deepEqual(
      eventIds(ALICE.email),
      [items['due'], items['planned'], items['shared']].map((id) => eventIdFor(id)).sort(),
    );
  });

  it('a push for an integration that is not the primary one is refused (409 calendar_not_primary)', async () => {
    const other = await (
      await models.getIntegrationRepository()
    ).create(wid, {
      connectedBy: ownerId,
      provider: 'google_calendar',
      accountId: 'owner-second-google',
      label: 'Second',
      authMethod: 'oauth',
      topicId: null,
      mode: 'read_write',
      config: { calendars: [] },
      status: 'active',
      lastError: null,
    });
    const before = writes();
    for (const confirm of [false, true]) {
      const refused = await as(owner, 'POST', '/gcal-sync', { integrationId: other.id, confirm });
      assert.equal(refused.status, 409, refused.text);
      assert.equal(refused.body?.['code'], 'calendar_not_primary');
    }
    assert.deepEqual(since(before), []);
    await (await models.getIntegrationRepository()).softDelete(wid, other.id);
  });

  it('a new calendar as the primary one: created, read, recorded; the events move there', async () => {
    const chosen = await as(owner, 'PUT', '/primary-calendar', {
      integrationId: iid,
      newCalendarName: 'TodoList',
    });
    assert.equal(chosen.status, 200, chosen.text);
    created = data(chosen.body)['calendarId'] as string;
    assert.match(created, /@group\.calendar\.google\.com$/);
    const config = (await (await models.getIntegrationRepository()).findById(wid, iid))?.config as {
      calendars: { id: string }[];
      appCreatedCalendars?: string[];
    };
    assert.ok(config.calendars.some((calendar) => calendar.id === created));
    assert.deepEqual(config.appCreatedCalendars, [created]);
    assert.deepEqual((await audits('workspace.primary_calendar')).at(0), {
      integrationId: iid,
      created: true,
    });

    await push();
    assert.deepEqual(eventIds(ALICE.email), []);
    assert.deepEqual(
      eventIds(created),
      [items['due'], items['planned'], items['shared']].map((id) => eventIdFor(id ?? '')).sort(),
    );
    const links = await (await models.getCalendarLinkRepository()).listLive(wid, iid);
    assert.deepEqual(
      links.map((link) => link.calendarId),
      [created, created, created],
    );
    // A second push has nothing left to do.
    const dry = await as(owner, 'POST', '/gcal-sync', { integrationId: iid });
    assert.deepEqual(data(dry.body)['counts'], { create: 0, update: 0, remove: 0 });
  });

  it('a deleted to-do’s event goes at once, through the write session, audited', async () => {
    const before = writes();
    const removed = await as(owner, 'DELETE', `/items/${items['due'] ?? ''}`);
    assert.equal(removed.status, 204, removed.text);
    assert.deepEqual(since(before), [
      `DELETE ${calendarPath(created)}/events/${eventIdFor(items['due'] ?? '')}`,
    ]);
    assert.equal(eventIds(created).includes(eventIdFor(items['due'] ?? '')), false);
    const link = await (
      await models.getCalendarLinkRepository()
    ).findByItem(wid, iid, items['due'] ?? '');
    assert.ok(link?.tombstonedAt instanceof Date);
    assert.deepEqual((await audits('integration.write')).at(0), {
      operation: 'event.delete',
      itemId: items['due'],
    });
  });

  it('read-only suspends it: shown so, never pushed; read & write again resumes it', async () => {
    await setMode('read');
    const shown = await as(owner, 'GET', '/primary-calendar');
    assert.deepEqual(
      [data(shown.body)['state'], data(shown.body)['reason']],
      ['suspended', 'read_only'],
    );
    const { runScheduledGcalSync } = await import('./scheduledSync.js');
    assert.deepEqual(await runScheduledGcalSync(iid), { ran: false, reason: 'not_eligible' });
    await setMode('read_write');
    assert.equal(data((await as(owner, 'GET', '/primary-calendar')).body)['state'], 'active');
  });
});

describe('another workspace on the same Google account (I1)', () => {
  it('pushes into a calendar the first workspace created: it is never that one’s to delete', async () => {
    const { Actor } = await import('../classes/base/Actor.js');
    const { Caller } = await import('../classes/base/Caller.js');
    const { Integration, isCalendarProvider } = await import('../classes/integration/index.js');
    const caller = await Caller.enter(wid, Actor.user(ownerId));
    assert.ok(caller);
    const first = await Integration.findOwn(caller, iid);
    assert.ok(isCalendarProvider(first));
    shared = (await first.createCalendar(caller, 'Shared TodoList')).id;

    other = (
      await (
        await models.getWorkspaceRepository()
      ).create({ name: 'Other', slug: `other-${randomUUID().slice(0, 8)}`, ownerId })
    ).id;
    await (
      await models.getMembershipRepository()
    ).create(other, { userId: ownerId, role: 'owner' });
    const theirs = await connect(other);
    const at = (path: string): string => `/api/private/workspaces/${other}${path}`;
    const switched = await api.call('PATCH', at(`/integrations/${theirs}`), {
      token: owner,
      body: { mode: 'read_write' },
    });
    assert.equal(switched.status, 200, switched.text);
    const chosen = await api.call('PUT', at('/primary-calendar'), {
      token: owner,
      body: { integrationId: theirs, calendarId: shared },
    });
    assert.equal(chosen.status, 200, chosen.text);
    const made = await api.call('POST', at('/items'), {
      token: owner,
      body: {
        title: 'Other workspace’s to-do',
        dueAt: new Date(Date.now() + 86_400_000).toISOString(),
      },
    });
    assert.equal(made.status, 201, made.text);
    const pushed = await api.call('POST', at('/gcal-sync'), {
      token: owner,
      body: { integrationId: theirs, confirm: true },
    });
    assert.equal(pushed.status, 202, pushed.text);
    assert.deepEqual(eventIds(shared), [eventIdFor(data(made.body)['id'] as string)]);
  });
});

describe('disconnect with "Also remove everything TodoList added to this calendar"', () => {
  it('deletes the pushed events and the calendars TodoList made that hold nothing else, then disconnects', async () => {
    const { Actor } = await import('../classes/base/Actor.js');
    const { Caller } = await import('../classes/base/Caller.js');
    const { Integration, isCalendarProvider } = await import('../classes/integration/index.js');
    const caller = await Caller.enter(wid, Actor.user(ownerId));
    assert.ok(caller);
    const integration = await Integration.findOwn(caller, iid);
    assert.ok(isCalendarProvider(integration));
    // A second calendar TodoList made, where the user then added an event of their own: kept.
    spare = (await integration.createCalendar(caller, 'Spare')).id;
    mock.addEvent(spare, {
      summary: 'My own plans',
      start: { date: '2026-12-01' },
      end: { date: '2026-12-02' },
    });
    // An event in the user's own calendar that TodoList did not add: never touched.
    mock.addEvent(ALICE.email, {
      summary: 'Not ours',
      start: { date: '2026-12-01' },
      end: { date: '2026-12-02' },
    });
    const live = (await (await models.getCalendarLinkRepository()).listLive(wid, iid)).map(
      (link) => `DELETE ${calendarPath(link.calendarId)}/events/${link.googleEventId}`,
    );
    assert.equal(live.length, 2);

    const before = writes();
    const removed = await as(owner, 'DELETE', `/integrations/${iid}?removeAdded=true`);
    assert.equal(removed.status, 200, removed.text);
    const sent = since(before);
    assert.deepEqual(sent.filter((line) => line.includes('/events/')).sort(), [...live].sort());
    // One calendar delete, for the calendar TodoList made that holds nothing else.
    assert.deepEqual(
      sent.filter((line) => /^DELETE \/calendar\/v3\/calendars\/[^/]+$/.test(line)),
      [`DELETE ${calendarPath(created)}`],
    );
    // Kept: the one holding the user's own event, and the one another workspace pushes into.
    assert.deepEqual(
      mock
        .createdCalendars()
        .map((calendar) => calendar.id)
        .sort(),
      [shared, spare].sort(),
    );
    assert.equal(eventIds(shared).length, 1, 'the other workspace’s event is untouched');
    assert.equal(eventIds(ALICE.email).length, 1);
    assert.deepEqual(await (await models.getCalendarLinkRepository()).listLive(wid, iid), []);
    // A claim just settled stays (another integration's push in flight must still see TodoList's
    // delete); nothing of it is live.
    const kept = await (
      await models.getCalendarLinkRepository()
    ).findByItem(wid, iid, items['due'] ?? '');
    assert.equal(kept?.deletedBy, 'dashboard');
    assert.ok(kept.deleteAnsweredAt instanceof Date);
    assert.deepEqual(await audits('integration.cleanup'), [
      { events: 2, calendars: 1, calendarsKept: 2, remaining: 0, skipped: 0, failed: 0 },
    ]);
    const stored = await (await models.getIntegrationRepository()).findIncludingDeleted(wid, iid);
    assert.ok(stored?.deletedAt instanceof Date);
    const shown = await as(owner, 'GET', '/primary-calendar');
    assert.deepEqual(
      [data(shown.body)['state'], data(shown.body)['reason'], data(shown.body)['mine']],
      ['suspended', 'disconnected', false],
    );
  });

  it('the owner clears it: unset, audited', async () => {
    const cleared = await as(owner, 'DELETE', '/primary-calendar');
    assert.equal(cleared.status, 200, cleared.text);
    assert.equal(data(cleared.body)['state'], 'unset');
    assert.deepEqual((await audits('workspace.primary_calendar')).at(0), { cleared: true });
    const byEditor = await as(editor, 'DELETE', '/primary-calendar');
    assert.equal(byEditor.status, 403, byEditor.text);
  });

  it('removeAdded on another provider is 400, and nothing is disconnected', async () => {
    const jira = await (
      await models.getIntegrationRepository()
    ).create(wid, {
      connectedBy: ownerId,
      provider: 'jira',
      accountId: 'primary.atlassian.net',
      label: 'Jira',
      authMethod: 'api_token_basic',
      topicId: null,
      config: { baseUrl: 'https://primary.atlassian.net' },
      status: 'active',
      lastError: null,
    });
    const refused = await as(owner, 'DELETE', `/integrations/${jira.id}?removeAdded=true`);
    assert.equal(refused.status, 400, refused.text);
    assert.equal(
      (await (await models.getIntegrationRepository()).findById(wid, jira.id))?.deletedAt,
      null,
    );
    const badQuery = await as(owner, 'DELETE', `/integrations/${jira.id}?removeAdded=yes`);
    assert.equal(badQuery.status, 400, badQuery.text);
  });

  it('no audit entry names a calendar; nothing but loopback was connected to', async () => {
    const all = await (await models.getAuditLogRepository()).list(wid, {}, 200);
    const text = JSON.stringify(all.map((entry) => entry.meta));
    for (const secret of [ALICE.email, created, spare, 'TodoList', 'Spare']) {
      assert.equal(text.includes(secret), false, secret);
    }
    assert.deepEqual(guard.externalHosts(), []);
  });
});
