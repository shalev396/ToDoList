/**
 * Write-back (plan Addendum A1) through TaskProvider#updateTask, per tracker, against a recording
 * transport that stands in for the provider: the exact requests a status, title and date change
 * sends (the lookups as reads, then the allow-listed writes), what the item holds afterwards (what
 * the provider confirmed; its source hash cleared for the next sync), each provider call audited
 * as it lands, a Jira edit that stops part-way (`provider_partial_write`, what landed kept), and
 * every refusal before anything is opened or written: a field the provider doesn't take
 * (`field_not_writable`), a status it can't reach (`status_not_available`), a value it can't hold,
 * a read-only integration (zero requests; an unchanged field is no write and no refusal), a pull
 * request, someone else's item.
 */
import { after, before, beforeEach, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import type { ItemData, ItemUpsert } from '../../models/definitions/Item.js';
import type { HttpRequest, HttpResponse, Transport } from '../../sync/http.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import {
  addDefaultTopics,
  contextFor,
  hasCode,
  hasStatus,
  newUser,
} from '../../testing/workspaceFixtures.js';
import type { AuthMethod, Provider } from '../../types/domain.js';
import type { Caller } from '../base/Caller.js';
import type * as Classes from './index.js';

const TZ = 'Asia/Jerusalem';
const JIRA_SITE = 'https://mysite.atlassian.net';
const LINEAR_ISSUE = '4a1b2c3d-0000-4000-8000-0000000000a1';
const STATE_TODO = '4a1b2c3d-0000-4000-8000-0000000000b1';
const STATE_CANCELED = '4a1b2c3d-0000-4000-8000-0000000000b2';
const STATE_DUPLICATE = '4a1b2c3d-0000-4000-8000-0000000000b3';

let db: TestDatabase;
let models: typeof Models;
let classes: typeof Classes;
let caller: Caller;
let otherCaller: Caller;
let wid: string;
let ownerId: string;
let accounts = 0;

/** What the stand-in was sent, and how it answers: routes by method and URL (or operation). */
const sent: HttpRequest[] = [];
let routes: { match: (request: HttpRequest) => boolean; answer: HttpResponse }[] = [];
const recording: Transport = {
  send(request: HttpRequest): Promise<HttpResponse> {
    sent.push(request);
    const route = routes.find((entry) => entry.match(request));
    return route === undefined
      ? Promise.reject(new Error(`unrouted ${request.method} ${request.url}`))
      : Promise.resolve(route.answer);
  },
};

const json = (status: number, body: unknown = ''): HttpResponse => ({
  status,
  headers: {},
  body: typeof body === 'string' ? body : JSON.stringify(body),
});
const on = (method: string, url: string, answer: HttpResponse, operation?: string): void => {
  routes.push({
    match: (request) =>
      request.method === method &&
      request.url === url &&
      (operation === undefined || request.graphqlOperation === operation),
    answer,
  });
};
/** The requests sent, as `METHOD url` (and the GraphQL operation). */
const lines = (): string[] =>
  sent.map(
    (request) =>
      `${request.method} ${request.url}${request.graphqlOperation === undefined ? '' : ` ${request.graphqlOperation}`}`,
  );
const bodyOf = (index: number): unknown => JSON.parse(sent[index]?.body ?? 'null');

before(async () => {
  db = await startTestDatabase('todolist_write_back_trackers');
  models = await import('../../models/index.js');
  classes = await import('./index.js');
  const { setCreateTransportForTests } = await import('./TrackerIntegration.js');
  setCreateTransportForTests(() => recording);
  const { Caller: CallerClass } = await import('../base/Caller.js');
  const { Actor } = await import('../base/Actor.js');
  const owner = await newUser('wb-owner');
  const other = await newUser('wb-other');
  ownerId = owner.id;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Write back', slug: 'write-back', ownerId, settings: { timezone: TZ } });
  wid = workspace.id;
  const memberships = await models.getMembershipRepository();
  await memberships.create(wid, { userId: ownerId, role: 'owner' });
  await memberships.create(wid, { userId: other.id, role: 'editor' });
  await addDefaultTopics(wid);
  caller = CallerClass.fromContext(await contextFor(wid, ownerId), Actor.user(ownerId));
  otherCaller = CallerClass.fromContext(await contextFor(wid, other.id), Actor.user(other.id));
});

after(async () => {
  const { setCreateTransportForTests } = await import('./TrackerIntegration.js');
  setCreateTransportForTests(null);
  await db.stop();
});

beforeEach(() => {
  sent.length = 0;
  routes = [];
});

const KEYS: Partial<Record<Provider, { method: AuthMethod; secret: Record<string, string> }>> = {
  jira: {
    method: 'api_token_basic',
    secret: { email: 'dev@example.test', token: 'FAKE-jira-key' },
  },
  clickup: { method: 'personal_token', secret: { token: 'FAKE-clickup-key' } },
  linear: { method: 'personal_api_key', secret: { apiKey: 'FAKE-linear-key' } },
  github: { method: 'fine_grained_pat', secret: { token: 'FAKE-github-key' } },
};

/** An integration of `provider` connected with its key, read & write unless said, with a credential. */
async function connect(
  provider: Provider,
  config: Record<string, unknown> = {},
  mode: 'read' | 'read_write' = 'read_write',
): Promise<Classes.TrackerIntegration> {
  const key = KEYS[provider];
  assert.ok(key !== undefined);
  accounts += 1;
  const data = await (
    await models.getIntegrationRepository()
  ).create(wid, {
    connectedBy: ownerId,
    provider,
    accountId: `wb-${provider}-${String(accounts)}`,
    label: provider,
    authMethod: key.method,
    topicId: null,
    mode,
    config,
  });
  const integration = classes.Integration.from(data);
  await integration.saveCredential(caller, key.secret);
  assert.ok(integration instanceof classes.TrackerIntegration);
  return integration;
}

/** The integration, once loaded, as the tracker it is. */
async function asTracker(
  pending: Promise<Classes.Integration>,
): Promise<Classes.TrackerIntegration> {
  const integration = await pending;
  assert.ok(integration instanceof classes.TrackerIntegration);
  return integration;
}

/** One mirrored item of `integration`, as a sync writes it (its source hash set). */
async function mirror(
  integration: Classes.TrackerIntegration,
  item: Omit<ItemUpsert, 'integrationId' | 'topicId' | 'source'> & {
    externalId: string;
    key?: string;
  },
): Promise<ItemData> {
  const { externalId, key = null, ...fields } = item;
  const account = { provider: integration.provider, accountId: integration.accountId };
  const items = await models.getItemRepository();
  await items.bulkUpsert(wid, [
    {
      ...fields,
      integrationId: integration.id,
      topicId: null,
      source: {
        ...account,
        externalId,
        key,
        url: `https://example.test/${externalId}`,
        updatedAtSource: null,
        etag: null,
        hash: 'h-synced',
      },
    },
  ]);
  const stored = await items.findBySource(
    wid,
    { ...account, integrationId: integration.id },
    externalId,
  );
  assert.ok(stored !== null);
  return stored;
}

const stored = async (id: string): Promise<ItemData | null> =>
  (await models.getItemRepository()).findById(wid, id);

/** The item's `integration.write` rows (their meta), in a stable order. */
const writes = async (itemId: string): Promise<unknown[]> =>
  (await (await models.getAuditLogRepository()).list(wid, { action: 'integration.write' }, 50))
    .filter((entry) => (entry.meta as { itemId?: string }).itemId === itemId)
    .map((entry) => entry.meta)
    .sort((a, b) => JSON.stringify(a).localeCompare(JSON.stringify(b)));

/** When the integration's credential was last opened (to show nothing was opened). */
const lastOpened = async (integration: Classes.TrackerIntegration): Promise<number | null> =>
  (
    await (await models.getCredentialRepository()).findMeta(wid, integration.id)
  )?.lastUsedAt?.getTime() ?? null;

describe('Jira', () => {
  const ISSUE = `${JIRA_SITE}/rest/api/3/issue/10500`;
  const EDITMETA = `${ISSUE}/editmeta`;
  const TRANSITIONS = `${ISSUE}/transitions?expand=transitions.fields`;
  const PRIORITIES = [
    { id: '1', name: 'Highest' },
    { id: '2', name: 'High' },
    { id: '3', name: 'Medium' },
    { id: '4', name: 'Low' },
    { id: '5', name: 'Lowest' },
  ];
  const EDITABLE = {
    fields: { summary: {}, duedate: {}, priority: { allowedValues: PRIORITIES } },
  };
  const LISTED = {
    transitions: [
      { id: '11', name: 'Back to do', to: { name: 'To Do', statusCategory: { key: 'new' } } },
      {
        id: '21',
        name: 'Start (with a form)',
        hasScreen: true,
        fields: { assignee: { required: false } },
        to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      },
      {
        id: '41',
        name: 'Resolve (asks for a resolution)',
        fields: { resolution: { required: true, hasDefaultValue: false } },
        to: { name: 'Resolved', statusCategory: { key: 'done' } },
      },
      {
        id: '51',
        name: 'Unavailable',
        isAvailable: false,
        to: { statusCategory: { key: 'done' } },
      },
      { id: '31', name: 'Finish', to: { name: 'Done', statusCategory: { key: 'done' } } },
    ],
  };
  const issue = (jira: Classes.TrackerIntegration): Promise<ItemData> =>
    mirror(jira, {
      kind: 'issue',
      title: 'Write the report',
      status: 'open',
      statusRaw: 'To Do',
      priority: 2,
      dueAt: null,
      allDay: false,
      externalId: '10500',
      key: 'ABC-7',
    });

  it('status, title and due date: the edit screen and transitions read, one PUT, one transition', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on('GET', EDITMETA, json(200, EDITABLE));
    on('GET', TRANSITIONS, json(200, LISTED));
    on('PUT', ISSUE, json(204));
    on('POST', `${ISSUE}/transitions`, json(204));
    const saved = await jira.updateTask(caller, item, {
      title: 'Ship the report',
      status: 'done',
      dueAt: new Date('2026-11-25T10:00:00Z'),
      priority: 2,
    });
    // The lookups first (nothing is written unless every part can be), then the two writes.
    assert.deepEqual(lines(), [
      `GET ${EDITMETA}`,
      `GET ${TRANSITIONS}`,
      `PUT ${ISSUE}`,
      `POST ${ISSUE}/transitions`,
    ]);
    // The priority is unchanged: not sent. The resolution transition needs a field: skipped.
    assert.deepEqual(bodyOf(2), { fields: { summary: 'Ship the report', duedate: '2026-11-25' } });
    assert.deepEqual(bodyOf(3), { transition: { id: '31' } });
    assert.equal(sent[2]?.headers['authorization']?.startsWith('Basic '), true);
    assert.equal(saved.title, 'Ship the report');
    assert.equal(saved.status, 'done');
    assert.equal(saved.statusRaw, 'Done');
    assert.ok(saved.closedAt instanceof Date);
    // A Jira due date is a day: its end, in the workspace's zone, all day.
    assert.equal(saved.dueAt?.toISOString(), '2026-11-25T21:59:00.000Z');
    assert.equal(saved.allDay, true);
    assert.equal(saved.source.hash, null, 'the next sync rewrites what Jira holds');
    // One row per provider call, each recorded as it landed.
    assert.deepEqual(await writes(item.id), [
      { operation: 'task.update', itemId: item.id, fields: ['status'] },
      { operation: 'task.update', itemId: item.id, fields: ['title', 'dueAt'] },
    ]);
  });

  it('a priority goes by the id the issue allows for its name; a name the scheme lacks is 422', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on('GET', EDITMETA, json(200, EDITABLE));
    on('PUT', ISSUE, json(204));
    const saved = await jira.updateTask(caller, item, { priority: 4 });
    assert.deepEqual(bodyOf(1), { fields: { priority: { id: '1' } } });
    assert.equal(saved.priority, 4);
    sent.length = 0;
    routes = [];
    on(
      'GET',
      EDITMETA,
      json(200, { fields: { priority: { allowedValues: [{ id: '9', name: 'P1' }] } } }),
    );
    await assert.rejects(jira.updateTask(caller, item, { priority: 0 }), (error: unknown) =>
      hasCode(422, 'field_not_writable')(error),
    );
    assert.deepEqual(lines(), [`GET ${EDITMETA}`], 'nothing written');
  });

  it('a field not on the edit screen, or no transition without a form: 422 before any write', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on('GET', EDITMETA, json(200, { fields: { summary: {} } }));
    await assert.rejects(
      jira.updateTask(caller, item, { title: 'Renamed', dueAt: new Date('2026-11-25T10:00:00Z') }),
      (error: unknown) =>
        hasCode(422, 'field_not_writable')(error) &&
        (error as { fields?: string[] }).fields?.join() === 'dueAt',
    );
    assert.deepEqual(lines(), [`GET ${EDITMETA}`]);
    sent.length = 0;
    routes = [];
    on('GET', EDITMETA, json(200, EDITABLE));
    // Into "done": only the transition that asks for a resolution, and an unavailable one.
    on(
      'GET',
      TRANSITIONS,
      json(200, {
        transitions: [LISTED.transitions[0], LISTED.transitions[2], LISTED.transitions[3]],
      }),
    );
    await assert.rejects(
      jira.updateTask(caller, item, { status: 'done', title: 'Renamed' }),
      hasCode(422, 'status_not_available'),
    );
    assert.deepEqual(lines(), [`GET ${EDITMETA}`, `GET ${TRANSITIONS}`]);
    const after = await stored(item.id);
    assert.equal(after?.title, 'Write the report');
    assert.equal(after.source.hash, 'h-synced');
    assert.deepEqual(await writes(item.id), []);
  });

  it('the fields land and the transition is refused: 409 provider_partial_write, what landed kept', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on('GET', EDITMETA, json(200, EDITABLE));
    on('GET', TRANSITIONS, json(200, LISTED));
    on('PUT', ISSUE, json(204));
    on('POST', `${ISSUE}/transitions`, json(400, { errorMessages: ['A validator failed'] }));
    await assert.rejects(
      jira.updateTask(caller, item, { title: 'Ship the report', status: 'in_progress' }),
      (error: unknown) =>
        hasCode(409, 'provider_partial_write')(error) &&
        (error as { written?: string[] }).written?.join() === 'title' &&
        (error as { refused?: string[] }).refused?.join() === 'status',
    );
    const after = await stored(item.id);
    assert.equal(after?.title, 'Ship the report', 'what Jira took is kept');
    assert.equal(after.status, 'open');
    assert.equal(after.source.hash, null);
    assert.deepEqual(await writes(item.id), [
      {
        operation: 'task.update',
        itemId: item.id,
        fields: ['title'],
        refused: ['status'],
        partial: true,
      },
      { operation: 'task.update', itemId: item.id, fields: ['title'] },
    ]);
  });

  it('the fields land and the transition gets no answer: "may or may not have", audited as uncertain', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on('GET', EDITMETA, json(200, EDITABLE));
    on('GET', TRANSITIONS, json(200, LISTED));
    on('PUT', ISSUE, json(204));
    on('POST', `${ISSUE}/transitions`, json(503, {}));
    await assert.rejects(
      jira.updateTask(caller, item, { title: 'Ship it', status: 'done' }),
      (error: unknown) =>
        hasCode(409, 'provider_partial_write')(error) &&
        (error as Error).message.includes('may or may not have taken status') &&
        !(error as Error).message.includes('but not') &&
        (error as { uncertain?: string[] }).uncertain?.join() === 'status' &&
        (error as { refused?: string[] }).refused?.length === 0,
    );
    assert.deepEqual(await writes(item.id), [
      {
        operation: 'task.update',
        itemId: item.id,
        fields: ['title'],
        uncertain: ['status'],
        partial: true,
      },
      { operation: 'task.update', itemId: item.id, fields: ['title'] },
    ]);
  });

  it('a write with no answer (a 5xx) is audited as unknown: it may have landed', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on('GET', EDITMETA, json(200, EDITABLE));
    on('PUT', ISSUE, json(502, {}));
    await assert.rejects(
      jira.updateTask(caller, item, { title: 'Renamed' }),
      (error: unknown) =>
        hasStatus(502)(error) && (error as Error).message.includes('may have been made there'),
    );
    assert.equal((await stored(item.id))?.title, 'Write the report', 'nothing saved here');
    assert.deepEqual(await writes(item.id), [
      { operation: 'task.update', itemId: item.id, fields: ['title'], outcome: 'unknown' },
    ]);
  });

  it('refused before the credential opens: cancelled, a null priority, a start date', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    const opened = await lastOpened(jira);
    await assert.rejects(
      jira.updateTask(caller, item, { status: 'cancelled' }),
      hasCode(422, 'status_not_available'),
    );
    await assert.rejects(jira.updateTask(caller, item, { priority: null }), hasStatus(400));
    await assert.rejects(
      jira.updateTask(caller, item, { startAt: new Date('2026-11-18T07:00:00Z') }),
      hasCode(422, 'field_not_writable'),
    );
    assert.deepEqual(sent, []);
    assert.equal(await lastOpened(jira), opened, 'the credential was never opened');
  });

  it('a refusal before anything landed saves nothing; a gone issue is 404 provider_item_missing', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on('GET', EDITMETA, json(200, EDITABLE));
    on('PUT', ISSUE, json(401, { errorMessages: ['FAKE-jira-key'] }));
    await assert.rejects(
      jira.updateTask(caller, item, { title: 'Renamed' }),
      (error: unknown) => hasStatus(409)(error) && !(error as Error).message.includes('FAKE'),
    );
    assert.equal((await stored(item.id))?.title, 'Write the report');
    assert.deepEqual(await writes(item.id), []);
    routes = [];
    on('GET', EDITMETA, json(404, {}));
    await assert.rejects(
      jira.updateTask(caller, item, { title: 'Renamed' }),
      hasCode(404, 'provider_item_missing'),
    );
    routes = [];
    on('GET', EDITMETA, json(200, EDITABLE));
    on('PUT', ISSUE, json(404, {}));
    await assert.rejects(
      jira.updateTask(caller, item, { title: 'Renamed' }),
      hasCode(404, 'provider_item_missing'),
    );
  });
});

describe('ClickUp', () => {
  const task = (clickup: Classes.TrackerIntegration): Promise<ItemData> =>
    mirror(clickup, {
      kind: 'task',
      title: 'Plan the trip',
      status: 'open',
      statusRaw: 'to do',
      priority: null,
      dueAt: null,
      allDay: false,
      externalId: '86b0xyz9',
      props: { listId: '901' },
    });

  it('status, dates and priority: the list’s statuses read, one PUT; a day due at its noon', async () => {
    const clickup = await connect('clickup');
    const item = await task(clickup);
    on(
      'GET',
      'https://api.clickup.com/api/v2/list/901',
      json(200, {
        statuses: [
          { status: 'to do', type: 'open', orderindex: 0 },
          { status: 'in review', type: 'custom', orderindex: 2 },
          { status: 'in progress', type: 'custom', orderindex: 1 },
          { status: 'complete', type: 'closed', orderindex: 3 },
        ],
      }),
    );
    on(
      'PUT',
      'https://api.clickup.com/api/v2/task/86b0xyz9',
      json(200, {
        id: '86b0xyz9',
        name: 'Plan the trip',
        status: { status: 'in progress', type: 'custom' },
      }),
    );
    const start = new Date('2026-11-24T08:00:00Z');
    const saved = await clickup.updateTask(caller, item, {
      status: 'in_progress',
      // 27 Nov, 23:30 in Jerusalem: still the 27th there.
      dueAt: new Date('2026-11-27T21:30:00Z'),
      allDay: true,
      startAt: start,
      priority: 3,
    });
    assert.deepEqual(lines(), [
      'GET https://api.clickup.com/api/v2/list/901',
      'PUT https://api.clickup.com/api/v2/task/86b0xyz9',
    ]);
    assert.deepEqual(bodyOf(1), {
      status: 'in progress',
      due_date: new Date('2026-11-27T10:00:00Z').getTime(),
      due_date_time: false,
      start_date: start.getTime(),
      start_date_time: true,
      priority: 2,
    });
    assert.equal(sent[1]?.headers['authorization'], 'FAKE-clickup-key');
    assert.equal(saved.status, 'in_progress');
    assert.equal(saved.statusRaw, 'in progress');
    assert.equal(saved.dueAt?.toISOString(), '2026-11-27T21:59:00.000Z');
    assert.equal(saved.allDay, true);
    assert.equal(saved.startAt?.toISOString(), start.toISOString());
    assert.equal(saved.priority, 3);
    assert.equal(saved.source.hash, null);
    assert.deepEqual(await writes(item.id), [
      {
        operation: 'task.update',
        itemId: item.id,
        fields: ['status', 'dueAt', 'startAt', 'priority'],
      },
    ]);
    // A cleared due date is no all-day either.
    routes = [];
    on('PUT', 'https://api.clickup.com/api/v2/task/86b0xyz9', json(200, { id: '86b0xyz9' }));
    const cleared = await clickup.updateTask(caller, saved, { dueAt: null });
    assert.equal(cleared.dueAt, null);
    assert.equal(cleared.allDay, false);
  });

  it('cancelled (no such type) and priority 0 (no lowest): refused before the credential opens', async () => {
    const clickup = await connect('clickup');
    const item = await task(clickup);
    const opened = await lastOpened(clickup);
    await assert.rejects(
      clickup.updateTask(caller, item, { status: 'cancelled' }),
      hasCode(422, 'status_not_available'),
    );
    await assert.rejects(clickup.updateTask(caller, item, { priority: 0 }), hasStatus(400));
    assert.deepEqual(sent, []);
    assert.equal(await lastOpened(clickup), opened);
  });
});

describe('Linear', () => {
  it('an OAuth grant without `write` (from before writes were on): 409 scope_missing, nothing opened', async () => {
    const { integration } = await classes.Integration.connectOAuth(caller, {
      provider: 'linear',
      accountId: 'wb-linear-oauth',
      label: 'Linear (OAuth)',
      config: {},
      topicSlug: 'personal',
      secret: { accessToken: 'FAKE-linear-access', refreshToken: 'FAKE-linear-refresh' },
      scopes: ['read', 'issues:create'],
    });
    const linear = await asTracker(
      (await classes.Integration.findOwn(caller, integration.id)).setMode(caller, 'read_write'),
    );
    const item = await mirror(linear, {
      kind: 'issue',
      title: 'Granted before writes',
      status: 'open',
      externalId: '4a1b2c3d-0000-4000-8000-0000000000c1',
    });
    const opened = await lastOpened(linear);
    await assert.rejects(
      linear.updateTask(caller, item, { title: 'Renamed' }),
      hasCode(409, 'scope_missing'),
    );
    assert.deepEqual(lines(), []);
    assert.equal(await lastOpened(linear), opened);
  });

  it('status, title and priority: the team’s states read, then the one issueUpdate mutation', async () => {
    const linear = await connect('linear');
    const item = await mirror(linear, {
      kind: 'issue',
      title: 'Fix the login',
      status: 'open',
      statusRaw: 'Todo',
      priority: 3,
      dueAt: null,
      allDay: false,
      externalId: LINEAR_ISSUE,
      key: 'ENG-7',
    });
    on(
      'POST',
      'https://api.linear.app/graphql',
      json(200, {
        data: {
          issue: {
            team: {
              states: {
                nodes: [
                  { id: STATE_DUPLICATE, name: 'Duplicate', type: 'canceled', position: 6 },
                  { id: STATE_TODO, name: 'Todo', type: 'unstarted', position: 1 },
                  { id: STATE_CANCELED, name: 'Canceled', type: 'canceled', position: 5 },
                ],
              },
            },
          },
        },
      }),
      'IssueTeamStates',
    );
    on(
      'POST',
      'https://api.linear.app/graphql',
      json(200, {
        data: {
          issueUpdate: {
            success: true,
            issue: {
              id: LINEAR_ISSUE,
              title: 'Fix the login page',
              state: { id: STATE_CANCELED, name: 'Canceled', type: 'canceled' },
            },
          },
        },
      }),
      'IssueUpdate',
    );
    const saved = await linear.updateTask(caller, item, {
      title: 'Fix the login page',
      status: 'cancelled',
      priority: null,
      dueAt: new Date('2026-12-01T09:00:00Z'),
    });
    assert.deepEqual(lines(), [
      'POST https://api.linear.app/graphql IssueTeamStates',
      'POST https://api.linear.app/graphql IssueUpdate',
    ]);
    const { LINEAR_ISSUE_UPDATE_DOCUMENT } = await import('./writers/trackerWriter.js');
    assert.deepEqual(bodyOf(1), {
      query: LINEAR_ISSUE_UPDATE_DOCUMENT,
      variables: {
        id: LINEAR_ISSUE,
        input: {
          title: 'Fix the login page',
          stateId: STATE_CANCELED,
          dueDate: '2026-12-01',
          priority: 0,
        },
      },
    });
    assert.equal(saved.title, 'Fix the login page');
    assert.equal(saved.status, 'cancelled');
    assert.equal(saved.statusRaw, 'Canceled');
    assert.equal(saved.priority, null);
    assert.equal(saved.dueAt?.toISOString(), '2026-12-01T21:59:00.000Z');
    assert.equal(saved.allDay, true);
  });
});

describe('GitHub', () => {
  const props = { github: { repo: 'octo/hello', number: 12, state: 'open' } };

  it('closing an issue as done: one PATCH of title and state; a due date is not GitHub’s to take', async () => {
    const github = await connect('github', { owner: 'octo', ownerType: 'user' });
    const item = await mirror(github, {
      kind: 'issue',
      title: 'Crash on start',
      status: 'open',
      statusRaw: 'open',
      priority: null,
      dueAt: null,
      allDay: false,
      externalId: 'I_kwDOissue12',
      key: 'octo/hello#12',
      props,
    });
    await assert.rejects(
      github.updateTask(caller, item, { title: 'x', dueAt: new Date('2026-11-30T10:00:00Z') }),
      hasCode(422, 'field_not_writable'),
    );
    assert.equal(sent.length, 0);
    on(
      'PATCH',
      'https://api.github.com/repos/octo/hello/issues/12',
      json(200, {
        number: 12,
        title: 'Crash on start (fixed)',
        state: 'closed',
        state_reason: 'completed',
        closed_at: '2026-11-15T10:00:00Z',
      }),
    );
    const saved = await github.updateTask(caller, item, {
      title: 'Crash on start (fixed)',
      status: 'done',
    });
    assert.deepEqual(lines(), ['PATCH https://api.github.com/repos/octo/hello/issues/12']);
    assert.deepEqual(bodyOf(0), {
      title: 'Crash on start (fixed)',
      state: 'closed',
      state_reason: 'completed',
    });
    assert.equal(sent[0]?.headers['x-github-api-version'], '2022-11-28');
    assert.equal(saved.status, 'done');
    assert.equal(saved.statusRaw, 'closed');
    assert.equal(saved.closedAt?.toISOString(), '2026-11-15T10:00:00.000Z');
    assert.deepEqual(await writes(item.id), [
      { operation: 'task.update', itemId: item.id, fields: ['title', 'status'] },
    ]);
  });

  it('"in progress" is a board column (422 both ways); a pull request takes no write-back (422 with its link)', async () => {
    const github = await connect('github', { owner: 'octo', ownerType: 'user' });
    const issueItem = await mirror(github, {
      kind: 'issue',
      title: 'Crash',
      status: 'open',
      statusRaw: 'open',
      externalId: 'I_kwDOissue13',
      props: { github: { repo: 'octo/hello', number: 13, state: 'open' } },
    });
    await assert.rejects(
      github.updateTask(caller, issueItem, { status: 'in_progress' }),
      hasCode(422, 'status_not_available'),
    );
    // Open, but its board column says in progress: "open" would change nothing and flip back.
    const onBoard = await mirror(github, {
      kind: 'issue',
      title: 'On the board',
      status: 'in_progress',
      statusRaw: 'In Progress',
      externalId: 'I_kwDOissue15',
      props: { github: { repo: 'octo/hello', number: 15, state: 'open' } },
    });
    await assert.rejects(
      github.updateTask(caller, onBoard, { status: 'open' }),
      hasCode(422, 'status_not_available'),
    );
    const pr = await mirror(github, {
      kind: 'pr',
      title: 'Fix the crash',
      status: 'open',
      statusRaw: 'open',
      externalId: 'PR_kwDOpr14',
      props: { github: { repo: 'octo/hello', number: 14 } },
    });
    await assert.rejects(
      github.updateTask(caller, pr, { title: 'Renamed' }),
      (error: unknown) =>
        hasCode(422, 'field_not_writable')(error) &&
        (error as { openIn?: { url: string } }).openIn?.url === 'https://example.test/PR_kwDOpr14',
    );
    assert.deepEqual(sent, []);
  });
});

describe('every tracker', () => {
  it('read-only, at every tracker: each field it takes is 409 with zero requests, the credential unopened', async () => {
    const cases: {
      provider: Provider;
      config: Record<string, unknown>;
      item: Parameters<typeof mirror>[1];
      patches: Parameters<Classes.TrackerIntegration['updateTask']>[2][];
    }[] = [
      {
        provider: 'jira',
        config: { baseUrl: JIRA_SITE },
        item: { kind: 'issue', title: 'J', status: 'open', priority: 2, externalId: '10901' },
        patches: [{ title: 'x' }, { status: 'done' }, { dueAt: new Date() }, { priority: 1 }],
      },
      {
        provider: 'clickup',
        config: {},
        item: {
          kind: 'task',
          title: 'C',
          status: 'open',
          priority: 2,
          externalId: 'ro86b0y',
          props: { listId: '901' },
        },
        patches: [{ title: 'x' }, { status: 'done' }, { startAt: new Date() }, { priority: 1 }],
      },
      {
        provider: 'linear',
        config: {},
        item: {
          kind: 'issue',
          title: 'L',
          status: 'open',
          priority: 2,
          externalId: '4a1b2c3d-0000-4000-8000-0000000000d1',
        },
        patches: [{ title: 'x' }, { status: 'cancelled' }, { dueAt: new Date() }, { priority: 1 }],
      },
      {
        provider: 'github',
        config: { owner: 'octo', ownerType: 'user' },
        item: {
          kind: 'issue',
          title: 'G',
          status: 'open',
          externalId: 'I_ro_1',
          key: 'octo/repo#1',
          props: { repo: 'octo/repo', number: 1 },
        },
        patches: [{ title: 'x' }, { status: 'done' }],
      },
    ];
    for (const entry of cases) {
      const tracker = await connect(entry.provider, entry.config, 'read');
      const item = await mirror(tracker, entry.item);
      const opened = await lastOpened(tracker);
      for (const patch of entry.patches) {
        await assert.rejects(
          tracker.updateTask(caller, item, patch),
          hasCode(409, 'integration_read_only'),
          `${entry.provider} ${Object.keys(patch).join()}`,
        );
      }
      assert.deepEqual(sent, [], `${entry.provider}: zero requests of any kind`);
      assert.equal(await lastOpened(tracker), opened, `${entry.provider}: never opened`);
      assert.deepEqual(await writes(item.id), []);
    }
  });

  it('read-only: a changed field is 409 with zero requests; resending what the item has is no write', async () => {
    const readOnly = await connect('clickup', {}, 'read');
    const item = await mirror(readOnly, {
      kind: 'task',
      title: 'Read only',
      status: 'open',
      priority: 2,
      externalId: 'ro86b0x',
      props: { listId: '901' },
    });
    const opened = await lastOpened(readOnly);
    for (const patch of [
      { title: 'Renamed' },
      { status: 'done' as const },
      { dueAt: new Date() },
    ]) {
      await assert.rejects(
        readOnly.updateTask(caller, item, patch),
        hasCode(409, 'integration_read_only'),
      );
    }
    // An ItemSheet that resends the form as it is: nothing changes, so nothing is refused.
    const same = await readOnly.updateTask(caller, item, {
      title: 'Read only',
      status: 'open',
      priority: 2,
      dueAt: null,
    });
    assert.equal(same.source.hash, 'h-synced', 'untouched');
    assert.deepEqual(sent, [], 'zero requests of any kind');
    assert.equal(await lastOpened(readOnly), opened, 'the credential was never opened');
    assert.deepEqual(await writes(item.id), []);
  });

  it('only its owner, only its own live mirrored items (404), and a valid edit (400)', async () => {
    const linear = await connect('linear');
    const item = await mirror(linear, {
      kind: 'issue',
      title: 'Mine',
      status: 'open',
      externalId: '4a1b2c3d-0000-4000-8000-0000000000c1',
    });
    const other = await connect('linear');
    const theirs = await mirror(other, {
      kind: 'issue',
      title: 'Another integration’s',
      status: 'open',
      externalId: '4a1b2c3d-0000-4000-8000-0000000000c2',
    });
    const local = await (
      await models.getItemRepository()
    ).createLocal(wid, {
      ownerUserId: ownerId,
      title: 'A local to-do',
      topicId: null,
    });
    await assert.rejects(linear.updateTask(otherCaller, item, { title: 'x' }), hasStatus(404));
    await assert.rejects(linear.updateTask(caller, theirs, { title: 'x' }), hasStatus(404));
    await assert.rejects(linear.updateTask(caller, local, { title: 'x' }), hasStatus(404));
    await assert.rejects(
      linear.updateTask(caller, { id: 'missing' }, { title: 'x' }),
      hasStatus(404),
    );
    await assert.rejects(linear.updateTask(caller, item, {}), hasStatus(400));
    await assert.rejects(linear.updateTask(caller, item, { title: 'A\nB' }), hasStatus(400));
    // TodoList's own fields are the overlay path's, never this method's.
    await assert.rejects(linear.updateTask(caller, item, { note: 'x' } as never), hasStatus(400));
    assert.deepEqual(sent, []);
  });
});
