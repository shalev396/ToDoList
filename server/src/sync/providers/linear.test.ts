import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { ItemData } from '../../models/definitions/Item.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { HttpRequest, Transport } from '../http.js';
import type { AdapterContext } from '../types.js';
import {
  LINEAR_DOCUMENTS,
  LINEAR_ENDPOINT,
  linearAdapter,
  linearStatus,
  mapLinearIssue,
  type LinearIssue,
  type LinearMapEnv,
} from './linear.js';
import {
  counts,
  FIXTURE_NOW,
  instantClock,
  OWNER,
  registerWithInstantClock,
  setTransport,
  startKit,
  TIME_ZONE,
  type Kit,
} from '../../testing/trackerTestKit.js';

const VIEWER = 'b6a1c7d2-0000-4000-8000-000000000001';

const ENV: LinearMapEnv = {
  accountId: 'lin-1',
  connectedBy: OWNER,
  viewerId: VIEWER,
  timeZone: TIME_ZONE,
};

function issue(extra: Partial<LinearIssue> = {}): LinearIssue {
  return {
    id: 'i-1',
    identifier: 'PER-1',
    title: 'Do it',
    url: 'https://example.invalid/linear/portfolio/issue/PER-1/do-it',
    state: { name: 'Todo', type: 'unstarted' },
    team: { id: 't-1', key: 'PER', name: 'Personal' },
    updatedAt: '2026-11-10T08:00:00.000Z',
    ...extra,
  };
}

function mapped(raw: LinearIssue): Extract<ReturnType<typeof mapLinearIssue>, { item: unknown }> {
  const result = mapLinearIssue(raw, ENV);
  assert.ok('item' in result, 'maps');
  return result;
}

describe('linearStatus', () => {
  it('maps state.type', () => {
    for (const type of ['backlog', 'unstarted', 'triage']) {
      assert.equal(linearStatus(type), 'open', type);
    }
    assert.equal(linearStatus('started'), 'in_progress');
    assert.equal(linearStatus('completed'), 'done');
    assert.equal(linearStatus('canceled'), 'cancelled');
    assert.equal(linearStatus('mystery'), null);
    assert.equal(linearStatus(undefined), null);
  });
});

describe('mapLinearIssue', () => {
  it('maps the basics: key, url, project container, props', () => {
    const { item, container } = mapped(
      issue({
        state: { name: 'In Progress', type: 'started' },
        project: { id: 'p-1', name: 'Portfolio site' },
        cycle: { number: 4 },
        estimate: 3,
        priority: 2,
        labels: { nodes: [{ name: 'zeta' }, { name: 'alpha' }] },
        description: 'Some text',
        assignee: { id: VIEWER, name: 'Demo Dev' },
      }),
    );
    assert.equal(container, null);
    assert.equal(item.kind, 'issue');
    assert.equal(item.title, 'Do it');
    assert.equal(item.status, 'in_progress');
    assert.equal(item.statusRaw, 'In Progress');
    assert.equal(item.priority, 3);
    assert.deepEqual(item.labels, ['alpha', 'zeta']);
    assert.equal(item.bodyPreview, 'Some text');
    assert.equal(item.source.externalId, 'i-1');
    assert.equal(item.source.key, 'PER-1');
    assert.equal(item.source.url, 'https://example.invalid/linear/portfolio/issue/PER-1/do-it');
    assert.equal(item.source.provider, 'linear');
    assert.equal(item.containerExternalId, 'project:p-1');
    assert.deepEqual(item.assignees, [OWNER]);
    assert.deepEqual(item.props, {
      teamKey: 'PER',
      cycle: 4,
      estimate: 3,
      linear: { estimate: 3, cycle: 4, cycleName: null },
      projectId: 'p-1',
      stateType: 'started',
      assigneeNames: ['Demo Dev'],
    });
  });

  it('no priority (0) is null; urgent is 4', () => {
    assert.equal(mapped(issue({ priority: 0 })).item.priority, null);
    assert.equal(mapped(issue({ priority: 1 })).item.priority, 4);
    assert.equal(mapped(issue({ priority: 4 })).item.priority, 1);
  });

  it('a date-only dueDate is 23:59 local time, all day', () => {
    const { item } = mapped(issue({ dueDate: '2026-11-15' }));
    assert.equal(item.dueAt?.toISOString(), '2026-11-15T21:59:00.000Z');
    assert.equal(item.allDay, true);
  });

  it('a bad dueDate is a failure with the issue id', () => {
    assert.deepEqual(mapLinearIssue(issue({ dueDate: 'soon' }), ENV), {
      failure: { externalId: 'i-1', code: 'bad_due_date' },
    });
  });

  it('an unknown state type is a failure', () => {
    assert.deepEqual(mapLinearIssue(issue({ state: { name: 'X', type: 'weird' } }), ENV), {
      failure: { externalId: 'i-1', code: 'unknown_status' },
    });
  });

  it('completed and canceled issues are closed at their own time', () => {
    const done = mapped(
      issue({
        state: { name: 'Done', type: 'completed' },
        completedAt: '2026-11-09T12:00:00.000Z',
      }),
    ).item;
    assert.deepEqual(
      [done.status, done.closedAt?.toISOString()],
      ['done', '2026-11-09T12:00:00.000Z'],
    );
    const dropped = mapped(
      issue({
        state: { name: 'Canceled', type: 'canceled' },
        canceledAt: '2026-11-08T12:00:00.000Z',
      }),
    ).item;
    assert.deepEqual(
      [dropped.status, dropped.closedAt?.toISOString()],
      ['cancelled', '2026-11-08T12:00:00.000Z'],
    );
  });

  it('an issue without a project lives in its team, a project-type container named after it', () => {
    const { item, container } = mapped(issue());
    assert.equal(item.containerExternalId, 'team:t-1');
    assert.equal(item.props?.['projectId'], null);
    assert.ok(container !== null);
    assert.deepEqual(
      [container.type, container.name, container.source.externalId],
      ['project', 'Personal', 'team:t-1'],
    );
    assert.equal(container.source.url, 'https://example.invalid/linear/portfolio/team/PER/all');
    assert.deepEqual(container.props, { teamKey: 'PER' });
  });

  it('an assignee other than the viewer is not mine', () => {
    const { item } = mapped(issue({ assignee: { id: 'someone', name: 'Noa' } }));
    assert.deepEqual(item.assignees ?? [], []);
    assert.deepEqual(item.props?.['assigneeNames'], ['Noa']);
  });

  it('a missing url maps to an empty url (the engine reports missing_url)', () => {
    assert.equal(mapped(issue({ url: null })).item.source.url, '');
  });
});

function contextFor(
  integration: IntegrationData,
  transport: Transport,
  secret: Record<string, string> = {},
): AdapterContext {
  return {
    integration,
    secret,
    client: linearAdapter.createClient(transport, instantClock()),
    now: FIXTURE_NOW,
    timeZone: TIME_ZONE,
    fullSyncDue: false,
  };
}

describe('linear adapter: engine runs over fixtures', () => {
  let kit: Kit;
  before(async () => {
    kit = await startKit('todolist_linear_test');
    registerWithInstantClock(linearAdapter);
  });
  after(async () => {
    await kit.stop();
  });

  it('resources: projects first', () => {
    assert.deepEqual(linearAdapter.resources({} as IntegrationData), ['projects', 'issues']);
  });

  it('allow-lists exactly three read-only documents', () => {
    assert.deepEqual(Object.keys(LINEAR_DOCUMENTS).sort(), [
      'AssignedIssues',
      'Projects',
      'Viewer',
    ]);
    for (const document of Object.values(LINEAR_DOCUMENTS)) {
      assert.doesNotMatch(document, /\b(mutation|subscription)\b/i);
      assert.match(document, /^\s*query\s/);
    }
  });

  it('refuses any operation that is not allow-listed', async () => {
    const transport = await setTransport(linearAdapter, 'v1');
    const client = linearAdapter.createClient(transport, instantClock());
    await assert.rejects(client.graphql('IssueCreate', {}), /not allow-listed/);
    assert.equal(transport.calls.length, 0);
  });

  it('v1 → v1 → v2: counts, the missing_url failure, closed and deleted', async () => {
    const s = await kit.setup('linear', { topicId: 'personal' });
    const first = await kit.run(s, linearAdapter);
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.counts, counts({ fetched: 9, inserted: 8, failed: 1 }));

    const containers = await kit.containers(s);
    assert.equal(containers.size, 2);
    const [project] = [...containers.values()].filter((c) => c.name === 'Portfolio site');
    assert.ok(project);
    assert.deepEqual([project.type, project.topicId], ['project', 'personal']);
    assert.equal(project.source.externalId, 'project:d0c0a000-0000-4000-8000-000000000020');
    const team = [...containers.values()].find((c) => c.name === 'Personal');
    assert.ok(team);
    assert.equal(team.type, 'project');

    const items = await kit.items(s);
    assert.equal(items.size, 8);
    const byKey = (key: string): ItemData => {
      const found = [...items.values()].find((i) => i.source.key === key);
      assert.ok(found, key);
      return found;
    };
    assert.equal(byKey('PER-1').containerId, project.id);
    assert.equal(byKey('PER-6').containerId, team.id);
    assert.deepEqual(byKey('PER-1').assignees, [OWNER]);
    assert.equal(byKey('PER-7').status, 'done');
    assert.equal(byKey('PER-3').status, 'open');
    assert.equal(byKey('PER-4').status, 'in_progress');
    assert.equal(byKey('PER-5').dueAt?.toISOString(), '2026-11-12T21:59:00.000Z');
    assert.equal(byKey('PER-4').priority, 4);
    assert.ok(![...items.values()].some((i) => i.source.key === 'PER-9'), 'no url: not stored');

    const again = await kit.run(s, linearAdapter);
    assert.deepEqual(again.counts, counts({ fetched: 9, unchanged: 8, failed: 1 }));

    const v2 = await kit.run(s, linearAdapter, { set: 'v2', later: true });
    assert.deepEqual(
      v2.counts,
      counts({ fetched: 8, updated: 2, unchanged: 5, closed: 1, deleted: 1, failed: 1 }),
    );
    const changed = await kit.items(s);
    const find = (key: string): ItemData => {
      const found = [...changed.values()].find((i) => i.source.key === key);
      assert.ok(found, key);
      return found;
    };
    assert.equal(find('PER-5').title, 'Add dark mode toggle and persist it');
    assert.equal(find('PER-2').status, 'done');
    assert.ok(find('PER-2').closedAt instanceof Date);
    assert.equal(find('PER-2').deletedAt, null);
    assert.ok(find('PER-8').deletedAt instanceof Date, 'removed at the source');
    assert.equal(find('PER-1').deletedAt, null);
  });

  it('an incremental run never sweeps, and filters on updatedAt after the cursor', async () => {
    const s = await kit.setup('linear');
    const transport = await setTransport(linearAdapter, 'v1');
    await kit.run(s, linearAdapter, { transport });
    const v2 = await kit.run(s, linearAdapter, { set: 'v2' });
    assert.equal(v2.counts.deleted, 0);

    const issueCalls = transport.calls.filter((call) => call.graphqlOperation === 'AssignedIssues');
    const filter = (call: HttpRequest | undefined): unknown => call?.variables?.['filter'];
    assert.deepEqual(filter(issueCalls[0]), { assignee: { isMe: { eq: true } } });

    const transport2 = await setTransport(linearAdapter, 'v1');
    await kit.run(s, linearAdapter, { transport: transport2 });
    const incremental = transport2.calls.find((call) => call.graphqlOperation === 'AssignedIssues');
    const sent = filter(incremental) as { assignee: unknown; updatedAt?: { gt?: string } };
    assert.deepEqual(sent.assignee, { isMe: { eq: true } });
    assert.match(sent.updatedAt?.gt ?? '', /^\d{4}-\d\d-\d\dT/);
  });

  it('transport spy: only POSTs of allow-listed queries to the Linear endpoint, never a mutation', async () => {
    const s = await kit.setup('linear');
    const transport = await setTransport(linearAdapter, 'v1');
    await kit.run(s, linearAdapter, { transport });
    assert.ok(transport.calls.length >= 4);
    for (const call of transport.calls) {
      assert.equal(call.method, 'POST');
      assert.equal(call.url, LINEAR_ENDPOINT);
      assert.ok(
        call.graphqlOperation !== undefined && call.graphqlOperation in LINEAR_DOCUMENTS,
        String(call.graphqlOperation),
      );
      assert.doesNotMatch(call.body ?? '', /\b(mutation|subscription)\b/i);
    }
  });

  it('test(): the viewer, with the viewer id', async () => {
    const s = await kit.setup('linear');
    const transport = await setTransport(linearAdapter, 'v1');
    const result = await linearAdapter.test?.(contextFor(s.integration, transport));
    assert.deepEqual(result, { accountLabel: 'Demo Dev', accountId: VIEWER });
    assert.deepEqual(
      transport.calls.map((call) => call.graphqlOperation),
      ['Viewer'],
    );
  });

  it('live headers: the API key as Authorization', async () => {
    const s = await kit.setup('linear');
    const seen: HttpRequest[] = [];
    const spy: Transport = {
      send(request) {
        seen.push(request);
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify({ data: { viewer: { id: VIEWER, name: 'Demo Dev' } } }),
        });
      },
    };
    await linearAdapter.test?.(contextFor(s.integration, spy, { apiKey: 'lin_api_FAKE_key' }));
    assert.equal(seen[0]?.headers['authorization'], 'lin_api_FAKE_key');
  });
});
