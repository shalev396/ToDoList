/**
 * Write-back (plan Addendum A1) through TaskProvider#updateTask, per tracker, against a recording
 * transport that stands in for the provider: the exact requests a status, title and date change
 * sends (the lookups as reads, then the allow-listed writes), that a field the provider lacks and
 * TodoList's own fields stay here and are never sent, what the item holds afterwards (what the
 * provider confirmed; its source hash cleared for the next sync), and every refusal before
 * anything is written: a read-only integration (zero requests), a status the provider can't reach
 * (`status_not_available`), a pull request, a value the provider can't hold, someone else's item.
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
let personalTopic: string;
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
  personalTopic = (await addDefaultTopics(wid)).personal;
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

const writes = async (itemId: string): Promise<unknown[]> =>
  (await (await models.getAuditLogRepository()).list(wid, { action: 'integration.write' }, 50))
    .filter((entry) => (entry.meta as { itemId?: string }).itemId === itemId)
    .map((entry) => entry.meta);

describe('Jira', () => {
  const transitions = `${JIRA_SITE}/rest/api/3/issue/10500/transitions`;
  const LISTED = {
    transitions: [
      { id: '11', name: 'Back to do', to: { name: 'To Do', statusCategory: { key: 'new' } } },
      {
        id: '21',
        name: 'Start (with a form)',
        hasScreen: true,
        to: { name: 'In Progress', statusCategory: { key: 'indeterminate' } },
      },
      {
        id: '41',
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

  it('status, title and due date: the transitions read, one PUT, one transition; the rest stays here', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on('GET', transitions, json(200, LISTED));
    on('PUT', `${JIRA_SITE}/rest/api/3/issue/10500`, json(204));
    on('POST', transitions, json(204));
    const start = new Date('2026-11-18T07:00:00Z');
    const saved = await jira.updateTask(caller, item, {
      title: 'Ship the report',
      status: 'done',
      dueAt: new Date('2026-11-25T10:00:00Z'),
      startAt: start,
      note: 'Only mine',
      pinned: true,
      topicOverride: personalTopic,
    });
    assert.deepEqual(lines(), [
      `GET ${transitions}`,
      `PUT ${JIRA_SITE}/rest/api/3/issue/10500`,
      `POST ${transitions}`,
    ]);
    // Jira has no start date; TodoList's own fields are never sent.
    assert.deepEqual(bodyOf(1), { fields: { summary: 'Ship the report', duedate: '2026-11-25' } });
    assert.deepEqual(bodyOf(2), { transition: { id: '31' } });
    assert.equal(sent[1]?.headers['authorization']?.startsWith('Basic '), true);
    assert.equal(saved.title, 'Ship the report');
    assert.equal(saved.status, 'done');
    assert.equal(saved.statusRaw, 'Done');
    assert.ok(saved.closedAt instanceof Date);
    // A Jira due date is a day: its end, in the workspace's zone, all day.
    assert.equal(saved.dueAt?.toISOString(), '2026-11-25T21:59:00.000Z');
    assert.equal(saved.allDay, true);
    assert.equal(saved.startAt?.toISOString(), start.toISOString());
    assert.equal(saved.overlay.note, 'Only mine');
    assert.equal(saved.overlay.pinned, true);
    assert.equal(saved.overlay.topicOverride, personalTopic);
    assert.equal(saved.source.hash, null, 'the next sync rewrites what Jira holds');
    assert.deepEqual(await writes(item.id), [
      { operation: 'task.update', itemId: item.id, fields: ['title', 'status', 'dueAt'] },
    ]);
  });

  it('prefers a transition without a screen; none into the category: 422, nothing written', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on(
      'GET',
      transitions,
      json(200, { transitions: [LISTED.transitions[0], LISTED.transitions[2]] }),
    );
    await assert.rejects(
      jira.updateTask(caller, item, { status: 'done', title: 'Renamed' }),
      hasCode(422, 'status_not_available'),
    );
    assert.deepEqual(lines(), [`GET ${transitions}`]);
    assert.equal((await stored(item.id))?.title, 'Write the report');
    assert.equal((await stored(item.id))?.source.hash, 'h-synced');
    // In progress: only the transition with a screen leads there, so that one.
    sent.length = 0;
    routes = [];
    on('GET', transitions, json(200, LISTED));
    on('POST', transitions, json(204));
    const started = await jira.updateTask(caller, item, { status: 'in_progress' });
    assert.deepEqual(bodyOf(1), { transition: { id: '21' } });
    assert.equal(started.status, 'in_progress');
    assert.equal(started.statusRaw, 'In Progress');
    assert.equal(started.closedAt, null);
  });

  it('cancelled has no Jira category, and a null priority no Jira value: refused before any request', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    await assert.rejects(
      jira.updateTask(caller, item, { status: 'cancelled' }),
      hasCode(422, 'status_not_available'),
    );
    await assert.rejects(jira.updateTask(caller, item, { priority: null }), hasStatus(400));
    assert.deepEqual(sent, []);
  });

  it('a refusal at Jira is an error and saves nothing here', async () => {
    const jira = await connect('jira', { baseUrl: JIRA_SITE });
    const item = await issue(jira);
    on(
      'PUT',
      `${JIRA_SITE}/rest/api/3/issue/10500`,
      json(401, { errorMessages: ['FAKE-jira-key'] }),
    );
    await assert.rejects(
      jira.updateTask(caller, item, { title: 'Renamed', note: 'x' }),
      (error: unknown) => hasStatus(409)(error) && !(error as Error).message.includes('FAKE'),
    );
    const after = await stored(item.id);
    assert.equal(after?.title, 'Write the report');
    assert.equal(after.overlay.note, null);
    assert.deepEqual(await writes(item.id), []);
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

  it('status, dates and priority: the list’s statuses read, one PUT; ClickUp’s answer confirms the status', async () => {
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
    const due = new Date('2026-11-27T15:00:00Z');
    const start = new Date('2026-11-24T08:00:00Z');
    const saved = await clickup.updateTask(caller, item, {
      status: 'in_progress',
      dueAt: due,
      allDay: false,
      startAt: start,
      priority: 3,
      hidden: true,
    });
    assert.deepEqual(lines(), [
      'GET https://api.clickup.com/api/v2/list/901',
      'PUT https://api.clickup.com/api/v2/task/86b0xyz9',
    ]);
    assert.deepEqual(bodyOf(1), {
      status: 'in progress',
      due_date: due.getTime(),
      due_date_time: true,
      start_date: start.getTime(),
      start_date_time: true,
      priority: 2,
    });
    assert.equal(sent[1]?.headers['authorization'], 'FAKE-clickup-key');
    assert.equal(saved.status, 'in_progress');
    assert.equal(saved.statusRaw, 'in progress');
    assert.equal(saved.dueAt?.toISOString(), due.toISOString());
    assert.equal(saved.allDay, false);
    assert.equal(saved.startAt?.toISOString(), start.toISOString());
    assert.equal(saved.priority, 3);
    assert.equal(saved.overlay.hidden, true);
    assert.equal(saved.source.hash, null);
  });

  it('cancelled (no such type in ClickUp) and priority 0 (no lowest): refused before any request', async () => {
    const clickup = await connect('clickup');
    const item = await task(clickup);
    await assert.rejects(
      clickup.updateTask(caller, item, { status: 'cancelled' }),
      hasCode(422, 'status_not_available'),
    );
    await assert.rejects(clickup.updateTask(caller, item, { priority: 0 }), hasStatus(400));
    assert.deepEqual(sent, []);
  });
});

describe('Linear', () => {
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
  const props = { github: { repo: 'octo/hello', number: 12 } };

  it('closing an issue as done: one PATCH of title and state; a due date stays here, unsent', async () => {
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
    const due = new Date('2026-11-30T10:00:00Z');
    const saved = await github.updateTask(caller, item, {
      title: 'Crash on start (fixed)',
      status: 'done',
      dueAt: due,
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
    assert.equal(saved.dueAt?.toISOString(), due.toISOString(), 'kept here');
    assert.deepEqual(await writes(item.id), [
      { operation: 'task.update', itemId: item.id, fields: ['title', 'status'] },
    ]);
  });

  it('"in progress" is a board column: 422; a pull request takes no write-back: 409 with its link', async () => {
    const github = await connect('github', { owner: 'octo', ownerType: 'user' });
    const issueItem = await mirror(github, {
      kind: 'issue',
      title: 'Crash',
      status: 'open',
      statusRaw: 'open',
      externalId: 'I_kwDOissue13',
      props: { github: { repo: 'octo/hello', number: 13 } },
    });
    await assert.rejects(
      github.updateTask(caller, issueItem, { status: 'in_progress' }),
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
        hasStatus(409)(error) &&
        (error as { openIn?: { url: string } }).openIn?.url === 'https://example.test/PR_kwDOpr14',
    );
    // Its TodoList fields are its own: they save, with no write session.
    const pinned = await github.updateTask(caller, pr, { pinned: true });
    assert.equal(pinned.overlay.pinned, true);
    assert.deepEqual(sent, []);
  });
});

describe('every tracker', () => {
  it('read-only: a provider field is 409 integration_read_only with zero requests; local fields still save', async () => {
    const readOnly = await connect('clickup', {}, 'read');
    const item = await mirror(readOnly, {
      kind: 'task',
      title: 'Read only',
      status: 'open',
      externalId: 'ro86b0x',
      props: { listId: '901' },
    });
    for (const patch of [
      { title: 'Renamed' },
      { status: 'done' as const },
      { dueAt: null, note: 'x' },
    ]) {
      await assert.rejects(
        readOnly.updateTask(caller, item, patch),
        hasCode(409, 'integration_read_only'),
      );
    }
    const noted = await readOnly.updateTask(caller, item, { note: 'Only mine', hidden: true });
    assert.equal(noted.overlay.note, 'Only mine');
    assert.equal(noted.source.hash, 'h-synced', 'nothing for the provider: untouched');
    assert.deepEqual(sent, [], 'zero requests of any kind');
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
    await assert.rejects(linear.updateTask(otherCaller, item, { note: 'x' }), hasStatus(404));
    await assert.rejects(linear.updateTask(caller, theirs, { note: 'x' }), hasStatus(404));
    await assert.rejects(linear.updateTask(caller, local, { note: 'x' }), hasStatus(404));
    await assert.rejects(
      linear.updateTask(caller, { id: 'missing' }, { note: 'x' }),
      hasStatus(404),
    );
    await assert.rejects(linear.updateTask(caller, item, {}), hasStatus(400));
    await assert.rejects(
      linear.updateTask(caller, item, { topicOverride: 'no-such-topic' }),
      hasStatus(400),
    );
    await assert.rejects(
      linear.updateTask(caller, item, { labels: ['x'] } as never),
      hasStatus(400),
    );
    assert.deepEqual(sent, []);
  });
});
