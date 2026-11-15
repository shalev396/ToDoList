import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { HttpRequest, Transport } from '../http.js';
import type { AdapterContext } from '../types.js';
import {
  clickupAdapter,
  clickupStatus,
  mapClickUpTask,
  type ClickUpMapEnv,
  type ClickUpTask,
} from './clickup.js';
import {
  counts,
  FIXTURE_NOW,
  instantClock,
  need,
  OWNER,
  registerWithInstantClock,
  setTransport,
  startKit,
  TIME_ZONE,
  type Kit,
} from '../../testing/trackerTestKit.js';
import { bindAuth } from '../../classes/integration/definitions/IntegrationDefinition.js';
import { CLICKUP } from '../../classes/integration/definitions/clickup.js';

const API = 'https://api.clickup.com/api/v2';

const ENV: ClickUpMapEnv = {
  accountId: 'cu-1',
  connectedBy: OWNER,
  meId: '183',
  timeZone: TIME_ZONE,
};

function task(extra: Partial<ClickUpTask> = {}): ClickUpTask {
  return {
    id: 'abc1',
    name: 'Ship it',
    status: { status: 'to do', type: 'open' },
    url: 'https://example.invalid/clickup/t/abc1',
    list: { id: '80001' },
    folder: { id: '70001', hidden: false },
    space: { id: '90010' },
    assignees: [],
    date_updated: '1794209400000',
    ...extra,
  };
}

function mappedItem(
  raw: ClickUpTask,
): Extract<ReturnType<typeof mapClickUpTask>, { item: unknown }> {
  const result = mapClickUpTask(raw, ENV);
  assert.ok('item' in result, 'maps');
  return result;
}

describe('clickupStatus', () => {
  it('maps status.type', () => {
    assert.equal(clickupStatus('open'), 'open');
    assert.equal(clickupStatus('custom'), 'in_progress');
    assert.equal(clickupStatus('closed'), 'done');
    assert.equal(clickupStatus('done'), 'done');
    assert.equal(clickupStatus('mystery'), null);
    assert.equal(clickupStatus(undefined), null);
  });
});

describe('mapClickUpTask', () => {
  it('maps the basics: url, ids, list container, props', () => {
    const { item } = mappedItem(
      task({
        status: { status: 'in progress', type: 'custom' },
        time_estimate: 3_600_000,
        priority: { id: '2', priority: 'high' },
        tags: [{ name: 'zeta' }, { name: 'alpha' }],
        text_content: 'Body text',
        parent: 'abc0',
        custom_fields: [
          { id: 'cf-b', name: 'B', value: 2 },
          { id: 'cf-a', name: 'A', value: 'x' },
          { id: 'cf-empty', name: 'Empty' },
        ],
      }),
    );
    assert.equal(item.kind, 'task');
    assert.equal(item.title, 'Ship it');
    assert.equal(item.status, 'in_progress');
    assert.equal(item.statusRaw, 'in progress');
    assert.equal(item.priority, 3);
    assert.deepEqual(item.labels, ['alpha', 'zeta']);
    assert.equal(item.bodyPreview, 'Body text');
    assert.equal(item.source.externalId, 'abc1');
    assert.equal(item.source.url, 'https://example.invalid/clickup/t/abc1');
    assert.equal(item.source.provider, 'clickup');
    assert.equal(item.containerExternalId, 'list:80001');
    assert.deepEqual(item.props, {
      listId: '80001',
      folderId: '70001',
      spaceId: '90010',
      timeEstimateMs: 3_600_000,
      clickup: { timeEstimateMs: 3_600_000, cf_a: 'x', cf_b: 2 },
      parentTaskId: 'abc0',
      customFields: [
        { id: 'cf-a', name: 'A', value: 'x' },
        { id: 'cf-b', name: 'B', value: 2 },
      ],
      assigneeNames: [],
    });
  });

  it('a hidden folder (folderless list) has no folderId', () => {
    const { item } = mappedItem(task({ folder: { id: 'hidden', hidden: true } }));
    assert.equal(item.props?.['folderId'], null);
  });

  it('due and start dates are epoch-ms strings; a timed due date keeps its time', () => {
    const { item } = mappedItem(
      task({ due_date: '1794209400000', start_date: '1794123000000', due_date_time: true }),
    );
    assert.equal(item.dueAt?.toISOString(), '2026-11-09T07:30:00.000Z');
    assert.equal(item.startAt?.toISOString(), '2026-11-08T07:30:00.000Z');
    assert.equal(item.allDay ?? false, false);
  });

  it('a date-only due date (due_date_time false) is 23:59 local that day, all day', () => {
    // 2026-11-14 00:00 in Asia/Jerusalem.
    const { item } = mappedItem(
      task({ due_date: String(Date.UTC(2026, 10, 13, 22, 0)), due_date_time: false }),
    );
    assert.equal(item.dueAt?.toISOString(), '2026-11-14T21:59:00.000Z');
    assert.equal(item.allDay, true);
  });

  it('a closed task keeps its close time', () => {
    const { item } = mappedItem(
      task({ status: { status: 'complete', type: 'closed' }, date_closed: '1794209400000' }),
    );
    assert.equal(item.status, 'done');
    assert.equal(item.closedAt?.toISOString(), '2026-11-09T07:30:00.000Z');
  });

  it('assignees: the connected account becomes the owner; names sorted', () => {
    const { item } = mappedItem(
      task({
        assignees: [
          { id: 184, username: 'Noa' },
          { id: 183, username: 'Demo Dev' },
        ],
      }),
    );
    assert.deepEqual(item.assignees, [OWNER]);
    assert.deepEqual(item.props?.['assigneeNames'], ['Demo Dev', 'Noa']);
    const other = mappedItem(task({ assignees: [{ id: 184, username: 'Noa' }] })).item;
    assert.deepEqual(other.assignees ?? [], []);
  });

  it('an unknown status type is a failure', () => {
    assert.deepEqual(mapClickUpTask(task({ status: { status: 'x', type: 'weird' } }), ENV), {
      failure: { externalId: 'abc1', code: 'unknown_status' },
    });
  });

  it('a task without a url maps with an empty url (the engine reports missing_url)', () => {
    const { item } = mappedItem(task({ url: undefined }));
    assert.equal(item.source.url, '');
  });
});

function contextFor(
  integration: IntegrationData,
  transport: Transport,
  secret: Record<string, string> = {},
): AdapterContext {
  const client = clickupAdapter.createClient(transport, instantClock());
  return {
    integration,
    secret,
    client,
    // The headers come from the integration's auth strategy, as in a run.
    auth: bindAuth(CLICKUP.auth, integration.authMethod, { secret, client, now: FIXTURE_NOW }),
    now: FIXTURE_NOW,
    timeZone: TIME_ZONE,
    fullSyncDue: false,
  };
}

describe('clickup adapter: engine runs over fixtures', () => {
  let kit: Kit;
  before(async () => {
    kit = await startKit('todolist_clickup_test');
    registerWithInstantClock(clickupAdapter);
  });
  after(async () => {
    await kit.stop();
  });

  it('resources: lists first', () => {
    assert.deepEqual(clickupAdapter.resources({} as IntegrationData), ['lists', 'tasks']);
  });

  it('v1 → v1 → v2: counts, the missing_url failure, closed and deleted', async () => {
    const s = await kit.setup('clickup');
    const first = await kit.run(s, clickupAdapter);
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.counts, counts({ fetched: 11, inserted: 10, failed: 1 }));

    const lists = await kit.containers(s);
    assert.deepEqual([...lists.values()].map((list) => [list.type, list.name, list.path]).sort(), [
      ['list', 'API', ['Roonga', 'Backend']],
      ['list', 'Backlog', ['Roonga']],
      ['list', 'Checkout', ['Parkbooker', 'Web']],
      ['list', 'Infra', ['Roonga', 'Backend']],
      ['list', 'Launch', ['Parkbooker']],
      ['list', 'Mobile app', ['Parkbooker']],
    ]);
    const api = need(lists, 'list:80001');
    assert.deepEqual(api.props, { listId: '80001', spaceId: '90010', folderId: '70001' });
    assert.equal(api.topicId, 'work');

    const items = await kit.items(s);
    assert.equal(items.size, 10);
    const one = need(items, '86f0t1');
    assert.equal(one.containerId, api.id);
    assert.deepEqual(one.assignees, [OWNER]);
    assert.equal(one.status, 'in_progress');
    assert.equal(need(items, '86f0t8').status, 'done');
    assert.ok(need(items, '86f0t8').closedAt instanceof Date);
    assert.equal(need(items, '86f0t6').status, 'in_progress');
    assert.equal(need(items, '86f0t11').props['parentTaskId'], '86f0t1');
    assert.ok(!items.has('86f0t10'), 'no url: not stored');
    // +5d at 00:00 local without a time part: that date at 23:59 local, all day.
    assert.equal(need(items, '86f0t7').dueAt?.toISOString(), '2026-11-17T21:59:00.000Z');
    assert.equal(need(items, '86f0t7').allDay, true);
    assert.equal(need(items, '86f0t2').dueAt?.toISOString(), '2026-11-12T16:00:00.000Z');

    const again = await kit.run(s, clickupAdapter);
    assert.deepEqual(again.counts, counts({ fetched: 11, unchanged: 10, failed: 1 }));

    const v2 = await kit.run(s, clickupAdapter, { set: 'v2', later: true });
    assert.deepEqual(
      v2.counts,
      counts({ fetched: 10, updated: 2, unchanged: 7, closed: 1, deleted: 1, failed: 1 }),
    );
    const after = await kit.items(s);
    assert.equal(need(after, '86f0t2').title, 'Add rate limiting to public API (per key)');
    const closed = need(after, '86f0t6');
    assert.equal(closed.status, 'done');
    assert.ok(closed.closedAt instanceof Date);
    assert.equal(closed.deletedAt, null);
    assert.ok(need(after, '86f0t9').deletedAt instanceof Date, 'removed at the source');
    assert.equal(need(after, '86f0t1').deletedAt, null);
    const afterLists = await kit.containers(s);
    assert.ok([...afterLists.values()].every((list) => list.deletedAt === null));
  });

  it('an incremental run never sweeps, and asks only for what changed', async () => {
    const s = await kit.setup('clickup');
    const transport = await setTransport(clickupAdapter, 'v1');
    await kit.run(s, clickupAdapter, { transport });
    const v2 = await kit.run(s, clickupAdapter, { set: 'v2' });
    assert.equal(v2.counts.deleted, 0);
    assert.equal(need(await kit.items(s), '86f0t9').deletedAt, null);

    const taskUrls = transport.calls
      .filter((call) => new URL(call.url).pathname.endsWith('/task'))
      .map((call) => new URL(call.url).searchParams);
    const first = taskUrls[0];
    assert.ok(first !== undefined);
    assert.equal(first.get('date_updated_gt'), null);
    assert.equal(first.get('assignees[]'), '183');
    assert.equal(first.get('include_closed'), 'true');
    assert.equal(first.get('subtasks'), 'true');
  });

  it('incremental task requests carry date_updated_gt from the cursor', async () => {
    const s = await kit.setup('clickup');
    const transport = await setTransport(clickupAdapter, 'v1');
    await kit.run(s, clickupAdapter, { transport });
    await kit.run(s, clickupAdapter, { transport });
    const params = transport.calls
      .filter((call) => new URL(call.url).pathname.endsWith('/task'))
      .map((call) => new URL(call.url).searchParams);
    const second = params.at(-1);
    assert.match(second?.get('date_updated_gt') ?? '', /^\d{13}$/);
  });

  it('only GET requests, all to the ClickUp API', async () => {
    const s = await kit.setup('clickup');
    const transport = await setTransport(clickupAdapter, 'v1');
    await kit.run(s, clickupAdapter, { transport });
    assert.ok(transport.calls.length >= 9);
    for (const call of transport.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.graphqlOperation, undefined);
      assert.equal(call.body, undefined);
      assert.ok(call.url.startsWith(`${API}/`), call.url);
    }
  });

  it('test(): who am I, with the user id', async () => {
    const s = await kit.setup('clickup');
    const transport = await setTransport(clickupAdapter, 'v1');
    const result = await clickupAdapter.test?.(contextFor(s.integration, transport));
    assert.deepEqual(result, { accountLabel: 'Demo Dev', accountId: '183' });
    assert.deepEqual(
      transport.calls.map((call) => [call.method, call.url]),
      [['GET', `${API}/user`]],
    );
  });

  it('live headers: the raw token as Authorization', async () => {
    const s = await kit.setup('clickup');
    const seen: HttpRequest[] = [];
    const spy: Transport = {
      send(request) {
        seen.push(request);
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify({ user: { id: 183, username: 'Demo Dev' } }),
        });
      },
    };
    await clickupAdapter.test?.(contextFor(s.integration, spy, { token: 'pk_FAKE_token' }));
    assert.equal(seen[0]?.headers['authorization'], 'pk_FAKE_token');
  });

  it('spaces its requests at least 650 ms apart', async () => {
    const clock = instantClock();
    const transport = await setTransport(clickupAdapter, 'v1');
    const client = clickupAdapter.createClient(transport, clock);
    await client.getJson(`${API}/user`);
    await client.getJson(`${API}/team`);
    await client.getJson(`${API}/user`);
    assert.equal(clock.sleeps.length, 2);
    assert.ok(clock.sleeps.every((ms) => ms >= 650 - 1 && ms <= 650));
  });
});
