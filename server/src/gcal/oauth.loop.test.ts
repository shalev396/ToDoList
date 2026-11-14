/**
 * Google Calendar with OAuth, end to end against the mock Google (in process, on a free port):
 * connect (start → authorize → callback), the calendar picker, a sync, a push, a second push with
 * nothing to do, an edit, a reconnect and a second account (many-to-one), the failure redirects,
 * and a disconnect that revokes the grant. An outbound guard proves nothing left the machine, and
 * no response or log line carries a token.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

import type * as Models from '../models/index.js';
import type * as RunSync from '../sync/runSync.js';
import { startApiHarness, type ApiHarness } from '../testing/apiHarness.js';
import { logsDuring } from '../testing/gcalFixture.js';
import {
  pointAppAtMockGoogle,
  startMockGoogle,
  MOCK_HOLIDAYS_CALENDAR,
  type MockGoogle,
} from '../testing/mockGoogle.js';
import { installOutboundGuard, type OutboundGuard } from '../testing/outboundGuard.js';
import { eventIdFor } from './diff.js';
import { forceSyncModeForTests } from '../config/testSwitches.js';

forceSyncModeForTests('fixtures');

const CLIENT_ID = 'FAKE-client-id.apps.googleusercontent.example';
const CLIENT_SECRET = 'FAKE-client-secret-0123456789';
const ALICE = { sub: '100000000000000000011', email: 'alice.calendar@example.test' };
const BOB = { sub: '100000000000000000022', email: 'bob.calendar@example.test' };

let guard: OutboundGuard;
let mock: MockGoogle;
let api: ApiHarness;
let models: typeof Models;
let runSync: typeof RunSync;
let token: string;
let wid: string;
let aliceId: string;
const answers: string[] = [];

before(async () => {
  guard = installOutboundGuard();
  mock = await startMockGoogle({
    clientId: CLIENT_ID,
    clientSecret: CLIENT_SECRET,
    port: 0,
    account: ALICE,
  });
  api = await startApiHarness('todolist_gcal_oauth_loop');
  // Google sends the browser back to the API itself here (no browser app in between).
  await pointAppAtMockGoogle(
    mock,
    { clientId: CLIENT_ID, clientSecret: CLIENT_SECRET },
    api.baseUrl,
  );
  models = await import('../models/index.js');
  runSync = await import('../sync/runSync.js');
  const login = await api.login('gcal-oauth-owner@example.test');
  token = login.token;
  const me = await api.call('GET', '/api/private/me', { token });
  const userId = (me.body?.['data'] as { id: string }).id;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Calendar', slug: `calendar-${randomUUID().slice(0, 8)}`, ownerId: userId });
  wid = workspace.id;
  await (await models.getMembershipRepository()).create(wid, { userId, role: 'owner' });
});

after(async () => {
  await api.stop();
  await mock.close();
  guard.restore();
});

const integrationsPath = (rest = ''): string =>
  `/api/private/workspaces/${wid}/integrations${rest}`;

async function call(
  method: string,
  path: string,
  body?: unknown,
): Promise<ReturnType<ApiHarness['call']>> {
  const res = await api.call(method, path, { token, ...(body === undefined ? {} : { body }) });
  answers.push(res.text);
  return res;
}

/** Start → the mock's authorize (auto-approved) → the callback, in one browser. The final Location. */
async function connect(): Promise<string> {
  const started = await fetch(`${api.baseUrl}${integrationsPath('/google-calendar/oauth/start')}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${token}` },
    body: '{}',
  });
  const text = await started.text();
  answers.push(text);
  assert.equal(started.status, 200, text);
  const cookie = /todolist_oauth=[A-Za-z0-9_-]{43}/.exec(
    started.headers.get('set-cookie') ?? '',
  )?.[0];
  assert.ok(cookie !== undefined);
  const { authorizeUrl } = (JSON.parse(text) as { data: { authorizeUrl: string } }).data;
  const authorized = await fetch(authorizeUrl, { redirect: 'manual' });
  assert.equal(authorized.status, 302);
  const back = authorized.headers.get('location') ?? '';
  assert.ok(back.startsWith(`${api.baseUrl}/api/public/oauth/google-calendar/callback?`), back);
  const landed = await fetch(back, { redirect: 'manual', headers: { cookie } });
  assert.equal(landed.status, 302);
  const location = landed.headers.get('location') ?? '';
  assert.match(location, /^\/en\/integrations\?(connected=[0-9a-f-]{36}|oauth_error=[a-z_]+)$/);
  return location;
}

const connectedId = (location: string): string => {
  const id = /connected=([0-9a-f-]{36})$/.exec(location)?.[1];
  assert.ok(id !== undefined, location);
  return id;
};

let iid: string;
let itemA: string;
let itemB: string;

describe('Google Calendar with OAuth, against the mock', () => {
  it('connects: the integration, its account, the primary calendar, a sealed credential', async () => {
    iid = connectedId(await connect());
    const integration = await (await models.getIntegrationRepository()).findById(wid, iid);
    assert.ok(integration);
    assert.equal(integration.provider, 'google_calendar');
    assert.equal(integration.authMethod, 'oauth');
    assert.equal(integration.accountId, ALICE.sub);
    assert.equal(integration.label, ALICE.email);
    assert.equal(integration.status, 'active');
    assert.equal(integration.mode, 'read_write');
    assert.deepEqual(integration.config, {
      calendars: [{ id: ALICE.email, mode: 'two_way' }],
      targetCalendarId: ALICE.email,
    });
    const credential = await (await models.getCredentialRepository()).findMeta(wid, iid);
    assert.equal(credential?.kind, 'oauth');
    const list = await call('GET', integrationsPath());
    const view = (list.body?.['data'] as Record<string, unknown>[]).find(
      (entry) => entry['id'] === iid,
    );
    assert.deepEqual(view && [view['authMethod'], view['accountLabel'], view['status']], [
      'oauth',
      ALICE.email,
      'connected',
    ]);
  });

  it('lists the account’s calendars for the picker', async () => {
    const res = await call('GET', integrationsPath(`/${iid}/calendars`));
    assert.equal(res.status, 200, res.text);
    assert.deepEqual(res.body?.['data'], [
      { id: ALICE.email, summary: ALICE.email, primary: true, accessRole: 'owner' },
      { id: MOCK_HOLIDAYS_CALENDAR, summary: 'Holidays', primary: false, accessRole: 'reader' },
    ]);
  });

  it('syncs live with the user’s token (the stage is in fixtures mode)', async () => {
    const start = new Date(Date.now() + 2 * 24 * 60 * 60 * 1000);
    mock.addEvent(ALICE.email, {
      summary: 'Dentist',
      start: { dateTime: start.toISOString() },
      end: { dateTime: new Date(start.getTime() + 3600_000).toISOString() },
    });
    const summary = await runSync.runIntegrationSync(iid, { trigger: 'manual', mode: 'live' });
    assert.equal(summary.status, 'succeeded', JSON.stringify(summary.error));
    const pulled = await (
      await models.getItemRepository()
    ).aggregate<{ title: string }>(wid, [{ $match: { 'source.provider': 'google_calendar' } }]);
    assert.deepEqual(
      pulled.map((item) => item.title),
      ['Dentist'],
    );
  });

  it('pushes through the Calendar API: deterministic ids, origin todolist, links', async () => {
    const items = await models.getItemRepository();
    const me = (await call('GET', '/api/private/me')).body?.['data'] as { id: string };
    const due = (days: number): Date => new Date(Date.now() + days * 24 * 60 * 60 * 1000);
    itemA = (
      await items.createLocal(wid, {
        ownerUserId: me.id,
        title: 'Write the report',
        topicId: 'personal',
        dueAt: due(2),
      })
    ).id;
    itemB = (
      await items.createLocal(wid, {
        ownerUserId: me.id,
        title: 'Call the bank',
        topicId: 'personal',
        dueAt: due(3),
      })
    ).id;

    const dry = await call('POST', `/api/private/workspaces/${wid}/gcal-sync`, {
      integrationId: iid,
    });
    assert.deepEqual(dry.body?.['data'], {
      dryRun: true,
      counts: { create: 2, update: 0, remove: 0 },
    });

    const pushed = await call('POST', `/api/private/workspaces/${wid}/gcal-sync`, {
      integrationId: iid,
      confirm: true,
    });
    assert.equal(pushed.status, 202, pushed.text);
    const runId = (pushed.body?.['data'] as { runId: string }).runId;
    const run = await (await models.getSyncRunRepository()).findById(wid, runId);
    assert.equal(run?.status, 'succeeded');
    assert.equal(run.trigger, 'calendar_push');
    assert.equal(run.counts['created'], 2);
    const events = mock.events(ALICE.email).filter((event) => event.summary !== 'Dentist');
    assert.deepEqual(
      events.map((event) => event.id).sort(),
      [eventIdFor(itemA), eventIdFor(itemB)].sort(),
    );
    assert.ok(
      events.every((event) => event.extendedProperties?.private?.['origin'] === 'todolist'),
    );
    const links = await (await models.getCalendarLinkRepository()).listLive(wid, iid);
    assert.equal(links.length, 2);
  });

  it('a second push has nothing to do, and a sync never imports the pushed events', async () => {
    const dry = await call('POST', `/api/private/workspaces/${wid}/gcal-sync`, {
      integrationId: iid,
    });
    assert.deepEqual(dry.body?.['data'], {
      dryRun: true,
      counts: { create: 0, update: 0, remove: 0 },
    });
    const pushed = await call('POST', `/api/private/workspaces/${wid}/gcal-sync`, {
      integrationId: iid,
      confirm: true,
    });
    const run = await (
      await models.getSyncRunRepository()
    ).findById(wid, (pushed.body?.['data'] as { runId: string }).runId);
    assert.deepEqual(
      [run?.counts['created'], run?.counts['updated'], run?.counts['deleted']],
      [0, 0, 0],
    );

    const summary = await runSync.runIntegrationSync(iid, { trigger: 'manual', mode: 'live' });
    assert.equal(summary.status, 'succeeded');
    const pulled = await (
      await models.getItemRepository()
    ).aggregate(wid, [{ $match: { 'source.provider': 'google_calendar', deletedAt: null } }]);
    assert.equal(pulled.length, 1, 'only the Google-native event');
  });

  it('an edit is patched with If-Match', async () => {
    await (
      await models.getItemRepository()
    ).updateLocal(wid, itemA, { title: 'Write the final report' });
    const pushed = await call('POST', `/api/private/workspaces/${wid}/gcal-sync`, {
      integrationId: iid,
      confirm: true,
    });
    const run = await (
      await models.getSyncRunRepository()
    ).findById(wid, (pushed.body?.['data'] as { runId: string }).runId);
    assert.equal(run?.counts['updated'], 1);
    assert.equal(
      mock.events(ALICE.email).find((event) => event.id === eventIdFor(itemA))?.summary,
      'Write the final report',
    );
  });

  it('the same account again is a reconnect; another account is a new integration', async () => {
    assert.equal(connectedId(await connect()), iid);
    mock.setAccount(BOB);
    const bob = connectedId(await connect());
    assert.notEqual(bob, iid);
    const list = await call('GET', integrationsPath());
    const calendars = (list.body?.['data'] as { provider: string; accountLabel: string }[])
      .filter((entry) => entry.provider === 'google_calendar')
      .map((entry) => entry.accountLabel)
      .sort();
    assert.deepEqual(calendars, [ALICE.email, BOB.email]);
    aliceId = iid;
    mock.setAccount(ALICE);
  });

  it('a refused consent, or a calendar permission left out, comes back as a code', async () => {
    mock.nextAuthorize('deny');
    assert.equal(await connect(), '/en/integrations?oauth_error=oauth_denied');
    const before = mock.grants().revoked;
    mock.nextAuthorize('no_calendar');
    assert.equal(await connect(), '/en/integrations?oauth_error=oauth_scope_missing');
    assert.equal(mock.grants().revoked, before + 1, 'the partial grant is handed back');
  });

  it('disconnect revokes the grant at Google, then runs the cascade', async () => {
    const live = mock.grants().live;
    const logs = await logsDuring(async () => {
      const res = await call('DELETE', integrationsPath(`/${aliceId}`));
      assert.equal(res.status, 204, res.text);
    });
    assert.equal(mock.grants().live, live - 1);
    assert.equal(await (await models.getCredentialRepository()).findMeta(wid, aliceId), null);
    assert.ok(!/ya29\.|1\/\/mock/.test(logs), 'no token in the logs');
  });

  it('no answer carried a token, and nothing but loopback was connected to', () => {
    for (const text of answers)
      assert.ok(!/ya29\.|1\/\/mock|4\/mock-code/.test(text), text.slice(0, 200));
    assert.deepEqual(guard.externalHosts(), []);
  });
});
