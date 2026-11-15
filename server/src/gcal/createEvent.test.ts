/**
 * H5: a to-do created as a Google Calendar event, against the mock Google: the calendar picker
 * (writable calendars only), an all-day event for a date-only to-do and a timed one otherwise, an
 * event id that makes a repeat the same event, no event without a due date, the created event
 * stored at once behind its to-do, and a user who is not the integration's owner refused.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type * as Models from '../models/index.js';
import { startApiHarness, type ApiHarness } from '../testing/apiHarness.js';
import { pointAppAtMockGoogle, startMockGoogle, type MockGoogle } from '../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';

forceSyncModeForTests('fixtures');

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000033', email: 'alice.events@example.test' };

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
let token: string;
let editorToken: string;
let wid: string;
let iid = '';

type Json = Record<string, unknown>;
const data = (body: Json | null): Json => (body?.['data'] ?? {}) as Json;
const W = (): string => `/api/private/workspaces/${wid}`;

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_gcal_create_event');
  // Google sends the browser back to the API itself here (no browser app in between).
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../models/index.js');
  const login = await api.login('gcal-create-owner@example.test');
  token = login.token;
  const me = await api.call('GET', '/api/private/me', { token });
  const userId = data(me.body)['id'] as string;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Events', slug: `events-${randomUUID().slice(0, 8)}`, ownerId: userId });
  wid = workspace.id;
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId, role: 'owner' });
  const editor = await api.login('gcal-create-editor@example.test');
  editorToken = editor.token;
  const editorMe = await api.call('GET', '/api/private/me', { token: editorToken });
  await memberships.create(wid, { userId: data(editorMe.body)['id'] as string, role: 'editor' });

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
  iid = connected[1] ?? '';
  // Every connection starts read-only; these tests create events, so its owner switches it on.
  const switched = await api.call('PATCH', `${W()}/integrations/${iid}`, {
    token,
    body: { mode: 'read_write' },
  });
  assert.equal(switched.status, 200, switched.text);
});

after(async () => {
  await api.stop();
  await mock.close();
  guard.restore();
});

async function todo(extra: Json = {}): Promise<string> {
  const created = await api.call('POST', `${W()}/items`, {
    token,
    body: { title: 'Dentist', ...extra },
  });
  assert.equal(created.status, 201, created.text);
  return data(created.body)['id'] as string;
}

const copy = (
  id: string,
  calendarId: string,
  requestId: string,
  as = token,
): ReturnType<ApiHarness['call']> =>
  api.call('POST', `${W()}/items/${id}/copies`, {
    token: as,
    body: { requestId, integrationId: iid, target: { provider: 'google_calendar', calendarId } },
  });

describe('a to-do as a calendar event', () => {
  it('lists the writable calendars only, primary first', async () => {
    const response = await api.call(
      'GET',
      `${W()}/integrations/${iid}/create-options?step=calendar`,
      { token },
    );
    assert.equal(response.status, 200, response.text);
    const options = data(response.body)['options'] as { id: string; hint?: string }[];
    assert.ok(options.length >= 1);
    assert.equal(options[0]?.hint, 'primary');
    assert.ok(options.every((option) => !option.id.includes('holiday')));
  });

  it('an all-day to-do is an all-day event, created once whatever the retries', async () => {
    const calendarId = ALICE.email;
    const id = await todo({ dueAt: '2026-11-20T09:00:00.000Z', allDay: true });
    const requestId = 'event-request-0001';
    const first = await copy(id, calendarId, requestId);
    assert.equal(first.status, 200, first.text);
    assert.equal(data(first.body)['status'], 'created');
    const again = await copy(id, calendarId, requestId);
    assert.equal(data(again.body)['status'], 'created');
    const events = mock.events(calendarId).filter((event) => event.summary === 'Dentist');
    assert.equal(events.length, 1);
    const [event] = events;
    assert.match(event?.id ?? '', /^h5[0-9a-f]{40}$/);
    assert.equal(JSON.stringify(event?.start), JSON.stringify({ date: '2026-11-20' }));
    assert.equal(JSON.stringify(event?.end), JSON.stringify({ date: '2026-11-21' }));
    assert.equal(
      event?.extendedProperties,
      undefined,
      'not a TodoList projection: the pull maps it',
    );
    // Stored at once and hidden behind its to-do: one row.
    const list = await api.call('GET', `${W()}/items?limit=100`, { token });
    const rows = (
      data(list.body)['items'] as { id: string; title: string; copies: unknown[] }[]
    ).filter((row) => row.title === 'Dentist');
    assert.equal(rows.length, 1);
    assert.equal(rows[0]?.copies.length, 1);
  });

  it('a timed to-do is a half-hour event at its time', async () => {
    const id = await todo({ dueAt: '2026-11-21T10:00:00.000Z', allDay: false, title: 'Call' });
    const result = await copy(id, ALICE.email, 'event-request-0002');
    assert.equal(data(result.body)['status'], 'created', result.text);
    const event = mock.events(ALICE.email).find((entry) => entry.summary === 'Call');
    assert.equal((event?.start as { dateTime: string }).dateTime, '2026-11-21T10:00:00.000Z');
    assert.equal((event?.end as { dateTime: string }).dateTime, '2026-11-21T10:30:00.000Z');
  });

  it('needs a due date (400 needs_due_date), and only the integration’s owner can create', async () => {
    const noDate = await todo({ title: 'Undated' });
    const refused = await copy(noDate, ALICE.email, 'event-request-0003');
    assert.equal(refused.status, 400);
    assert.equal(refused.body?.['code'], 'needs_due_date');
    const theirs = await api.call('POST', `${W()}/items`, {
      token: editorToken,
      body: { title: 'Theirs', dueAt: '2026-11-22T10:00:00.000Z' },
    });
    const id = data(theirs.body)['id'] as string;
    assert.equal((await copy(id, ALICE.email, 'event-request-0004', editorToken)).status, 404);
  });
});
