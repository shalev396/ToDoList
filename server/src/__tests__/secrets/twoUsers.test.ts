/**
 * The secret-leak suite's two-user scenario (PERMISSIONS-V2 ruling 23): user A owns a workspace
 * and connects every kind of integration, with values that mark them (account labels, an account
 * email, config values) plus sync runs, audit entries, unshared items and a private to-do. One of
 * A's integrations is shared (a connector on a block). User B, an editor there, then calls every
 * route of the manifest aimed at A's resources, and every MCP tool. B must never receive any of
 * A's markers: not a label, an email, a config value, an unshared integration's id, a sync run, an
 * audit detail or an unshared item. Shared items are B's to see; their integration's details are
 * not.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import type { ItemUpsert } from '../../models/definitions/Item.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { MANIFEST, type Ctx, type Entry } from './manifest.js';
import {
  CLICKUP_CREDENTIAL,
  SERVICE_ACCOUNT_CREDENTIAL,
  GITHUB_CREDENTIAL,
  LINEAR_CREDENTIAL,
  MOODLE_CREDENTIAL,
} from './seed.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

const MARK = randomBytes(6).toString('hex');
const P = '/api/private';

let api: ApiHarness;
let tokenA = '';
let tokenB = '';
let userA = '';
let userB = '';
let ctx: Ctx;
/** Values of A's that B must never receive, by what they are (reports name the kind only). */
const markers: { kind: string; value: string }[] = [];
/** Every answer B got: REST bodies and MCP results. */
const seenByB: { label: string; text: string }[] = [];
let mcp: Client | null = null;
/** A's items B may see (on a shared block) and may not, and the block that shares them. */
let sharedItemId = '';
let unsharedItemId = '';
let blockId = '';

function mark(kind: string, value: string): string {
  markers.push({ kind, value });
  return value;
}

function dataOf(res: ApiResponse): Record<string, unknown> {
  assert.ok(res.status < 400, `${String(res.status)} ${res.text.slice(0, 200)}`);
  return res.body?.['data'] as Record<string, unknown>;
}

async function asA(method: string, path: string, body?: unknown): Promise<ApiResponse> {
  return api.call(method, path, { token: tokenA, ...(body === undefined ? {} : { body }) });
}

async function asB(
  method: string,
  path: string,
  label: string,
  body?: unknown,
): Promise<ApiResponse> {
  const res = await api.call(method, path, {
    token: tokenB,
    ...(body === undefined ? {} : { body }),
  });
  seenByB.push({ label, text: res.text });
  assert.ok(res.status < 500, `${label} answered ${String(res.status)}: ${res.text.slice(0, 160)}`);
  return res;
}

before(async () => {
  api = await startApiHarness('todolist_secret_two_users');
  const models = await import('../../models/index.js');
  tokenA = (await api.login('two-users-a@example.test')).token;
  tokenB = (await api.login('two-users-b@example.test')).token;
  userA = (dataOf(await asA('GET', `${P}/me`)) as { id: string }).id;
  userB = ((await api.call('GET', `${P}/me`, { token: tokenB })).body?.['data'] as { id: string })
    .id;

  const wid = (
    dataOf(await asA('POST', `${P}/workspaces`, { name: 'Two users' })) as { id: string }
  ).id;
  const base = `${P}/workspaces/${wid}`;
  await (await models.getMembershipRepository()).create(wid, { userId: userB, role: 'editor' });

  // A's integrations: every provider, each with values that mark it.
  const connect = async (
    body: Record<string, unknown>,
    credential: Record<string, string>,
  ): Promise<string> => {
    const created = dataOf(await asA('POST', `${base}/integrations`, body));
    const iid = created['id'] as string;
    const put = await asA('PUT', `${base}/integrations/${iid}/credential`, credential);
    assert.equal(put.status, 204, put.text);
    return iid;
  };
  const connectDirect = async (
    integration: {
      provider: 'moodle' | 'google_calendar';
      authMethod: 'moodle_ws_token' | 'service_account';
      accountId: string;
      config: Record<string, unknown>;
    },
    credential: Record<string, string>,
  ): Promise<string> => {
    const row = await (
      await models.getIntegrationRepository()
    ).create(wid, {
      ...integration,
      connectedBy: userA,
      ownerUserId: userA,
      label: integration.provider,
      topicId: null,
    });
    const put = await asA('PUT', `${base}/integrations/${row.id}/credential`, credential);
    assert.equal(put.status, 204, put.text);
    return row.id;
  };
  const jiraHost = mark('jira site (account and label)', `amark${MARK}.atlassian.net`);
  const integrations: Ctx['integrations'] = {
    jira: await connect(
      { provider: 'jira', config: { baseUrl: `https://${jiraHost}`, jql: `project = A${MARK}` } },
      {
        email: mark('jira account email', `a-jira-${MARK}@private.example`),
        token: ['ATATT3x', 'FAKE', MARK, '0123456789abcdefghijKLMN'].join(''),
      },
    ),
    clickup: await connect({ provider: 'clickup', config: {} }, CLICKUP_CREDENTIAL),
    linear: await connect({ provider: 'linear', config: {} }, LINEAR_CREDENTIAL),
    // Moodle and a service-account Google Calendar can't be connected over REST: stored directly.
    moodle: await connectDirect(
      {
        provider: 'moodle',
        authMethod: 'moodle_ws_token',
        accountId: mark('moodle site', `moodle-${MARK}.example.ac.il`),
        config: { siteUrl: `https://${mark('moodle site', `moodle-${MARK}.example.ac.il`)}` },
      },
      MOODLE_CREDENTIAL,
    ),
    github: await connect(
      {
        provider: 'github',
        config: { owner: mark('github owner', `aorg${MARK}`), ownerType: 'org' },
      },
      GITHUB_CREDENTIAL,
    ),
    gcal: await connectDirect(
      {
        provider: 'google_calendar',
        authMethod: 'service_account',
        accountId: `gcal-sa-${MARK}`,
        config: {
          calendars: [
            { id: mark('calendar id', `a-cal-${MARK}@group.calendar.google.com`), mode: 'two_way' },
          ],
        },
      },
      SERVICE_ACCOUNT_CREDENTIAL,
    ),
  };
  // Labels A chose, and the account email of a Google Calendar connected with Google.
  for (const [key, iid] of Object.entries(integrations)) {
    if (key === 'jira') continue;
    const label = mark(`${key} label`, `A ${key} ${MARK}`);
    assert.equal((await asA('PATCH', `${base}/integrations/${iid}`, { label })).status, 200);
  }
  const oauth = await (
    await models.getIntegrationRepository()
  ).create(wid, {
    connectedBy: userA,
    provider: 'google_calendar',
    accountId: `google-sub-${MARK}`,
    label: mark('google account email', `a-google-${MARK}@gmail.example`),
    authMethod: 'oauth',
    topicId: null,
    config: { calendars: [] },
  });
  // A's calendar is the workspace's primary calendar: B sees that one is set, never its ids.
  await (
    await models.getWorkspaceRepository()
  ).setPrimaryCalendar(wid, { integrationId: oauth.id, calendarId: `a-target-${MARK}` });
  mark('calendar target', `a-target-${MARK}`);
  // Unshared integrations' ids: B never learns them (an audit entry shows only the provider).
  for (const [key, iid] of Object.entries(integrations)) {
    if (key !== 'jira') mark(`${key} integration id`, iid);
  }
  mark('oauth integration id', oauth.id);

  // A's sync runs, items and a private to-do.
  const runs = await models.getSyncRunRepository();
  for (const iid of [integrations.linear, integrations.jira]) {
    const run = await runs.create(wid, {
      integrationId: iid,
      trigger: 'manual',
      status: 'succeeded',
    });
    mark('sync run id', run.id);
  }
  const items = await models.getItemRepository();
  const issue = (integrationId: string, title: string, externalId: string): ItemUpsert => ({
    integrationId,
    kind: 'issue' as const,
    topicId: null,
    title,
    status: 'open' as const,
    dueAt: new Date(Date.now() + 86_400_000),
    source: {
      provider: 'jira' as const,
      accountId: jiraHost,
      externalId,
      key: `A-${externalId}`,
      url: `https://example.invalid/${externalId}`,
      updatedAtSource: null,
      etag: null,
      hash: `h-${externalId}`,
    },
  });
  const unshared = issue(integrations.linear, mark('unshared item', `A unshared ${MARK}`), 'u-1');
  await items.bulkUpsert(wid, [
    issue(integrations.jira, 'A shared issue', 'shared-1'),
    { ...unshared, source: { ...unshared.source, provider: 'linear', accountId: 'linear' } },
  ]);
  const { ItemMongoModel } = await import('../../models/mongoose/Item.js');
  const idOf = async (externalId: string): Promise<string> => {
    const doc = await ItemMongoModel.findOne({ workspaceId: wid, 'source.externalId': externalId })
      .select({ _id: 1 })
      .lean<{ _id: string }>();
    assert.ok(doc, externalId);
    return doc._id;
  };
  sharedItemId = await idOf('shared-1');
  unsharedItemId = mark('unshared item id', await idOf('u-1'));
  const privateTodo = await items.createLocal(wid, {
    ownerUserId: userA,
    title: mark('private to-do', `A private ${MARK}`),
    topicId: null,
    visibility: 'private',
  });
  // A's private weekly time block (Sundays 13:00–17:00 in Jerusalem).
  const privateBlock = await items.createLocal(wid, {
    ownerUserId: userA,
    title: mark('private time block', `A block ${MARK}`),
    topicId: null,
    kind: 'block',
    visibility: 'private',
    startAt: new Date('2026-11-22T11:00:00.000Z'),
    endAt: new Date('2026-11-22T15:00:00.000Z'),
    props: { layer: 'block', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU'], exceptions: [] },
  });

  // A shares the Jira integration: a block on a dashboard of A's.
  const dashboard = dataOf(await asA('POST', `${base}/dashboards`, { title: 'A board' }));
  const written = dataOf(
    await asA('POST', `${base}/dashboards/${dashboard['id'] as string}/ops`, {
      expectedVersion: dashboard['version'],
      ops: [
        {
          op: 'add_block',
          block: {
            type: 'list',
            title: 'Shared',
            query: { source: 'items' },
            connectors: [integrations.jira],
          },
        },
      ],
    }),
  );
  const board = dataOf(await asA('GET', `${base}/dashboards/${dashboard['id'] as string}`));
  blockId = (board['blocks'] as { id: string }[])[0]?.id ?? '';
  const topic = dataOf(await asA('POST', `${base}/topics`, { name: 'A page' }));
  const view = dataOf(
    await asA('POST', `${base}/views`, {
      title: 'A view',
      query: { source: 'items' },
      viz: { kind: 'list' },
    }),
  );
  const invite = dataOf(
    await asA('POST', `${base}/invites`, {
      email: 'two-users-invitee@example.test',
      role: 'viewer',
    }),
  );
  const inviteUrl = invite['inviteUrl'] as string;
  const key = dataOf(await asA('POST', `${base}/agent-keys`, { name: 'A key', scopes: ['read'] }));
  const throwaway = dataOf(await asA('POST', `${P}/workspaces`, { name: 'A elsewhere' }));
  ctx = {
    wid,
    throwawayWid: throwaway['id'] as string,
    itemId: privateTodo.id,
    timeBlockId: privateBlock.id,
    dashboardId: dashboard['id'] as string,
    dashboardVersion: written['version'] as number,
    viewId: view['id'] as string,
    topicId: (topic['topic'] as { id: string }).id,
    inviteId: (invite['invite'] as { id: string }).id,
    inviteToken: inviteUrl.slice(inviteUrl.lastIndexOf('/') + 1).split('?')[0] ?? '',
    agentKeyId: key['id'] as string,
    memberIds: { patched: userA, removed: userA },
    integrations,
  };
});

after(async () => {
  await mcp?.close();
  await api.stop();
});

/** Every string in a value, at any depth. */
function stringsIn(value: unknown): string[] {
  if (typeof value === 'string') return [value];
  if (Array.isArray(value)) return value.flatMap(stringsIn);
  if (typeof value === 'object' && value !== null) return Object.values(value).flatMap(stringsIn);
  return [];
}

/** An answer, without the values B sent itself: echoing B's own input tells B nothing. */
function withoutInput(text: string, args: Record<string, unknown>): string {
  return stringsIn(args)
    .filter((value) => value.length > 3)
    .reduce((rest, value) => rest.split(value).join('<input>'), text);
}

/**
 * Arguments for every MCP tool B's key may call, aimed at A's resources (as the REST manifest
 * aims each route): A's dashboard and block, A's unshared integration, A's private to-do, the
 * unshared item, the shared one. Writes run as dry runs or previews where the tool has one.
 */
function toolFixtures(expectedVersion: number): Record<string, Record<string, unknown>[]> {
  const dashboardId = ctx.dashboardId;
  const board = { dashboardId, expectedVersion };
  const foreign = ctx.integrations.linear;
  return {
    search_items: [{}, { q: 'shared' }, { q: MARK }, { provider: 'linear' }],
    list_today: [{}],
    list_deadlines: [{}, { days: 30, includeOverdue: true }],
    get_calendar: [{}, { range: 'month' }],
    get_item: [{ id: sharedItemId }, { id: unsharedItemId }, { id: ctx.itemId }],
    list_facets: [{}],
    query_items: [
      { draft: { source: 'items' } },
      { draft: { source: 'items' }, connectors: [foreign] },
      { dashboardId, blockId },
    ],
    create_todo: [
      { title: 'B to-do' },
      // H5: targets at A's integration: B's key has no providers:create, and it is not B's anyway.
      {
        title: 'B to-do with targets',
        confirm: true,
        targets: [
          {
            integrationId: ctx.integrations.jira,
            target: { provider: 'jira', projectId: '10001', issueTypeId: '10002' },
          },
        ],
      },
    ],
    update_todo: [{ id: ctx.itemId, title: 'Taken' }],
    create_time_block: [
      {
        subject: 'B subject',
        startAt: '2026-11-23T08:00:00.000Z',
        endAt: '2026-11-23T09:00:00.000Z',
      },
    ],
    edit_time_block: [
      { id: ctx.timeBlockId, scope: 'all', title: 'Taken' },
      { id: ctx.timeBlockId, scope: 'this', originalStart: '2026-11-29T11:00:00.000Z', skip: true },
    ],
    complete_todo: [{ id: ctx.itemId }],
    delete_todo: [{ id: ctx.itemId }],
    set_overlay: [{ id: unsharedItemId, pinned: true }],
    list_attributes: [{}],
    set_item_attributes: [{ id: unsharedItemId, attrs: { importance: 5 } }],
    set_subject: [{ name: 'Algebra', family: 'teal', patterns: ['*algebra*'] }],
    sync_now: [{}, { integrationIds: [foreign] }],
    get_sync_status: [{}, { integrationId: foreign }, { runId: 'x' }],
    sync_to_google_calendar: [{ dryRun: true }],
    integrations_list: [{}],
    integrations_start_connect: [{ provider: 'clickup' }],
    integrations_disconnect: [
      { integrationId: foreign },
      { integrationId: foreign, confirm: true },
    ],
    workspace_get: [{}],
    workspace_list_members: [{}],
    audit_log_query: [{}, { limit: 100 }],
    builder_list_dashboards: [{}],
    builder_get_dashboard: [{ dashboardId }],
    builder_list_block_types: [{}],
    builder_list_templates: [{}],
    builder_validate: [{ draft: { title: 'B', blocks: [] } }],
    builder_preview: [{ ...board, ops: [{ op: 'set_title', title: 'B title' }] }],
    builder_create_dashboard: [{ fromTemplate: 'dashboard', dryRun: true }],
    builder_add_block: [
      {
        ...board,
        block: {
          type: 'list',
          title: 'Theirs',
          viz: { kind: 'list' },
          query: { source: 'items' },
          connectors: [foreign],
        },
        dryRun: true,
      },
    ],
    builder_instantiate_persona: [{ personaKey: 'light-student@1', dryRun: true }],
    builder_add_view: [
      { ...board, type: 'list', config: { connectors: [foreign] }, dryRun: true },
      { ...board, templateKey: 'my-open-work@1', dryRun: true },
    ],
    builder_update_view: [{ ...board, viewId: 'vw_missing1', title: 'Taken', dryRun: true }],
    builder_remove_view: [{ ...board, viewId: 'vw_missing1', dryRun: true }],
    builder_update_block: [{ ...board, blockId, patch: { title: 'Taken' }, dryRun: true }],
    builder_arrange: [{ ...board, layouts: { lg: [] }, dryRun: true }],
    builder_connect_blocks: [
      {
        ...board,
        fromBlockId: blockId,
        variable: '$page.range',
        toBlockIds: [blockId],
        dryRun: true,
      },
    ],
    builder_apply_patch: [
      { ...board, patch: [{ op: 'replace', path: '/title', value: 'Taken' }], dryRun: true },
    ],
    builder_apply_template: [{ ...board, templateKey: 'dashboard', mode: 'merge', dryRun: true }],
    builder_remove_block: [{ ...board, blockId, dryRun: true }],
    builder_list_versions: [{ dashboardId }],
    builder_undo: [{ ...board, dryRun: true }],
    builder_revert: [{ ...board, toVersion: 1, dryRun: true }],
  };
}

function expand(entry: Entry): string {
  const params: Record<string, string | undefined> = { wid: ctx.wid, ...entry.params?.(ctx) };
  return entry.path.replace(/[:*]([A-Za-z]+)/g, (_whole, name: string) =>
    encodeURIComponent(params[name] ?? name),
  );
}

/** Calls that end B's own access or account, or run as someone else: not B's to make here. */
function skipped(entry: Entry): boolean {
  if (entry.as === 'anon' || entry.as === 'throwaway') return true;
  return (
    entry.method === 'DELETE' &&
    (entry.path === `${P}/delete` || entry.path.endsWith('/members/me'))
  );
}

describe('two users: B never receives A’s integration details or unshared data', () => {
  it('B’s own integration list is empty, and every route on A’s integrations is 404', async () => {
    const base = `${P}/workspaces/${ctx.wid}`;
    const list = await asB('GET', `${base}/integrations`, 'GET integrations');
    assert.deepEqual(list.body?.['data'], []);
    for (const iid of Object.values(ctx.integrations)) {
      for (const [method, suffix] of [
        ['GET', '/config'],
        ['POST', '/test'],
        ['POST', '/sync'],
        ['POST', '/stop-sharing'],
        ['PATCH', ''],
        ['DELETE', ''],
      ] as const) {
        const res = await asB(
          method,
          `${base}/integrations/${iid}${suffix}`,
          `${method} …${suffix}`,
          method === 'PATCH' ? { label: 'Taken' } : undefined,
        );
        assert.equal(res.status, 404, `${method} ${suffix}: ${res.text}`);
      }
      const runs = await asB('GET', `${base}/sync-runs?integrationId=${iid}`, 'GET sync-runs');
      assert.equal(runs.status, 404);
    }
    const members = await asB('GET', `${base}/members`, 'GET members');
    const a = (members.body?.['data'] as { userId: string; providers: string[] }[]).find(
      (member) => member.userId === userA,
    );
    // A's provider icons, deduplicated (two Google Calendars show once): never an account.
    assert.deepEqual([...(a?.providers ?? [])].sort(), [
      'clickup',
      'github',
      'google_calendar',
      'jira',
      'linear',
      'moodle',
    ]);
  });

  it('every manifest route, called by B against A’s resources, answers without A’s markers', async () => {
    let calls = 0;
    for (const entry of MANIFEST) {
      if (skipped(entry)) continue;
      const query = entry.query === undefined ? '' : `?${entry.query}`;
      await asB(
        entry.method,
        `${expand(entry)}${query}`,
        `${entry.method} ${entry.path}`,
        entry.body?.(ctx),
      );
      calls += 1;
    }
    assert.ok(calls > 60, `only ${String(calls)} routes were called`);
  });

  it('every MCP tool, called by B’s agent key against A’s data, answers without A’s markers', async () => {
    const { insertAgentKey } = await import('../../mcp/__tests__/helpers/agentKeys.js');
    const key = await insertAgentKey({
      workspaceId: ctx.wid,
      userId: userB,
      scopes: [
        'read',
        'items:write',
        'sync',
        'gcal:write',
        'integrations:read',
        'integrations:connect',
        'workspace:read',
        'builder:write',
      ],
    });
    const transport = new StreamableHTTPClientTransport(new URL(`${api.baseUrl}/api/mcp`), {
      requestInit: { headers: { authorization: `Bearer ${key.raw}` } },
    });
    mcp = new Client({ name: 'two-users', version: '1.0.0' });
    await mcp.connect(transport);
    const { tools } = await mcp.listTools();
    assert.ok(tools.length > 20, `only ${String(tools.length)} tools`);
    // The draft as it is now (the REST walk above wrote to it).
    const current = dataOf(
      await asA('GET', `${P}/workspaces/${ctx.wid}/dashboards/${ctx.dashboardId}`),
    );
    const fixtures = toolFixtures(current['version'] as number);
    assert.deepEqual(
      tools.map((tool) => tool.name).filter((name) => !(name in fixtures)),
      [],
      'every tool B may call has argument fixtures',
    );
    let calls = 0;
    const answered = new Set<string>();
    for (const tool of tools) {
      for (const args of fixtures[tool.name] ?? []) {
        let text: string;
        try {
          const result = await mcp.callTool({ name: tool.name, arguments: args });
          if (result.isError !== true) answered.add(tool.name);
          text = JSON.stringify(result);
        } catch (error) {
          text = String(error);
        }
        seenByB.push({ label: `mcp ${tool.name}`, text: withoutInput(text, args) });
        calls += 1;
      }
    }
    // Each read tool got past its input validation at least once: the sweep read real answers.
    assert.deepEqual(
      tools
        .filter((tool) => tool.annotations?.readOnlyHint === true)
        .map((tool) => tool.name)
        .filter((name) => !answered.has(name)),
      [],
      'every read tool answered at least once',
    );
    // The unshared item's id (ruling 14): not found, the same as an unknown id.
    for (const id of [unsharedItemId, ctx.itemId]) {
      const hidden = await mcp.callTool({ name: 'get_item', arguments: { id } });
      assert.equal(hidden.isError, true);
    }
    const seen = await mcp.callTool({ name: 'get_item', arguments: { id: sharedItemId } });
    assert.notEqual(seen.isError, true, 'the shared item is B’s to see');

    // The audit log: A's integration events show only their provider to B.
    const audit = await mcp.callTool({
      name: 'audit_log_query',
      arguments: { action: 'integration.update', limit: 100 },
    });
    seenByB.push({ label: 'mcp audit_log_query', text: JSON.stringify(audit) });
    const entries = (
      audit.structuredContent as {
        entries: { targetType: string | null; targetId: string | null; provider: string | null }[];
      }
    ).entries;
    const aboutIntegrations = entries.filter((entry) => entry.targetType === 'integration');
    assert.ok(aboutIntegrations.length > 0);
    for (const entry of aboutIntegrations) {
      assert.equal(entry.targetId, null);
      assert.notEqual(entry.provider, null);
    }
    assert.ok(calls > tools.length, `only ${String(calls)} MCP calls`);

    // B's agent can't add A's connector either (ruling 15): the dry run says why, the write is
    // refused, whether A's integration is shared (Jira) or not (Linear).
    const draft = await asB(
      'GET',
      `${P}/workspaces/${ctx.wid}/dashboards/${ctx.dashboardId}`,
      'GET dashboard',
    );
    const version = (draft.body?.['data'] as { version: number }).version;
    for (const foreign of [ctx.integrations.jira, ctx.integrations.linear]) {
      const args = {
        dashboardId: ctx.dashboardId,
        expectedVersion: version,
        block: {
          type: 'list',
          title: 'Their issues',
          viz: { kind: 'list' },
          query: { source: 'items' },
          connectors: [foreign],
        },
      };
      const dry = await mcp.callTool({
        name: 'builder_add_block',
        arguments: { ...args, dryRun: true },
      });
      const preview = dry.structuredContent as { valid: boolean; errors: { code: string }[] };
      assert.equal(preview.valid, false);
      assert.deepEqual(
        preview.errors.map((error) => error.code),
        ['integration_not_found'],
      );
      const write = await mcp.callTool({ name: 'builder_add_block', arguments: args });
      assert.equal(write.isError, true);
      assert.match(
        JSON.stringify(write.content),
        /only your own integrations can be added to a block/,
      );
    }
  });

  it('nothing B received holds a marker of A’s', () => {
    assert.ok(seenByB.length > 100, `only ${String(seenByB.length)} answers`);
    for (const { kind, value } of markers) {
      for (const answer of seenByB) {
        assert.ok(!answer.text.includes(value), `${answer.label} returned A’s ${kind}`);
      }
    }
  });
});
