import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { HttpRequest, HttpResponse, Transport } from '../http.js';
import type { AdapterContext } from '../types.js';
import {
  jiraAdapter,
  jiraStatus,
  jqlFor,
  mapJiraIssue,
  type JiraIssue,
  type JiraMapEnv,
} from './jira.js';
import {
  counts,
  FIXTURE_NOW,
  need,
  OWNER,
  setTransport,
  startKit,
  TIME_ZONE,
  type Kit,
} from './trackerTestKit.js';

const BASE = 'https://example.invalid/jira';
const ME = 'FAKE-jira-account-001';

const ENV: JiraMapEnv = {
  accountId: 'site-1',
  baseUrl: BASE,
  connectedBy: OWNER,
  meAccountId: ME,
  timeZone: TIME_ZONE,
};

function issue(fields: Record<string, unknown> = {}, extra: Partial<JiraIssue> = {}): JiraIssue {
  return {
    id: '10101',
    key: 'ADS-101',
    fields: {
      summary: 'Fix it',
      status: { name: 'To Do', statusCategory: { key: 'new' } },
      issuetype: { name: 'Bug' },
      project: { id: '10001', key: 'ADS' },
      updated: '2026-11-10T08:00:00.000Z',
      ...fields,
    },
    ...extra,
  };
}

function mapped(raw: JiraIssue): ReturnType<typeof mapJiraIssue> {
  return mapJiraIssue(raw, ENV);
}

function mappedItem(raw: JiraIssue): Extract<ReturnType<typeof mapJiraIssue>, { item: unknown }> {
  const result = mapped(raw);
  assert.ok('item' in result, 'maps');
  return result;
}

describe('jiraStatus', () => {
  it('maps the status category', () => {
    assert.equal(jiraStatus('new'), 'open');
    assert.equal(jiraStatus('indeterminate'), 'in_progress');
    assert.equal(jiraStatus('done'), 'done');
    assert.equal(jiraStatus('undefined'), null);
    assert.equal(jiraStatus(undefined), null);
  });
});

describe('mapJiraIssue', () => {
  it('maps the basics: key, url, kind, status, raw status, props', () => {
    const { item } = mappedItem(
      issue({
        status: { name: 'In Review', statusCategory: { key: 'indeterminate' } },
        issuetype: { name: 'Story' },
        customfield_10016: 5,
        customfield_10020: [
          { name: 'Sprint 13', state: 'closed' },
          { name: 'Sprint 14', state: 'active' },
        ],
        parent: { key: 'ADS-90', fields: { issuetype: { name: 'Epic' } } },
        priority: { name: 'High' },
        labels: ['zeta', 'alpha'],
      }),
    );
    assert.equal(item.kind, 'issue');
    assert.equal(item.title, 'Fix it');
    assert.equal(item.status, 'in_progress');
    assert.equal(item.statusRaw, 'In Review');
    assert.equal(item.priority, 3);
    assert.deepEqual(item.labels, ['alpha', 'zeta']);
    assert.equal(item.source.externalId, '10101');
    assert.equal(item.source.key, 'ADS-101');
    assert.equal(item.source.url, `${BASE}/browse/ADS-101`);
    assert.equal(item.source.provider, 'jira');
    assert.equal(item.source.accountId, 'site-1');
    assert.equal(item.containerExternalId, 'project:10001');
    assert.deepEqual(item.props, {
      issueType: 'Story',
      projectKey: 'ADS',
      sprint: 'Sprint 14',
      storyPoints: 5,
      epicKey: 'ADS-90',
      jira: { storyPoints: 5, sprint: 'Sprint 14', epicKey: 'ADS-90' },
      assigneeNames: [],
    });
  });

  it('maps named custom fields under stable props.jira.cf_<slug> keys (plain values only)', () => {
    const { item } = mappedItem(
      issue(
        {
          customfield_20001: { value: 'High' },
          customfield_20002: 8,
          customfield_20003: ['a', 'b'],
          customfield_20004: 'no name',
        },
        {
          names: {
            customfield_20001: 'Risk level',
            customfield_20002: 'Team size!',
            customfield_20003: 'Tags',
          },
        },
      ),
    );
    const jira = item.props?.['jira'] as Record<string, unknown>;
    assert.equal(jira['cf_risk_level'], 'High');
    assert.equal(jira['cf_team_size'], 8);
    assert.ok(!('cf_tags' in jira));
    assert.ok(!Object.keys(jira).some((key) => key.includes('20004')));
  });

  it('takes the epic from the classic epic link field when the parent is not an epic', () => {
    const { item } = mappedItem(
      issue({
        parent: { key: 'ADS-7', fields: { issuetype: { name: 'Story' } } },
        customfield_10014: 'ADS-55',
      }),
    );
    assert.equal(item.props?.['epicKey'], 'ADS-55');
  });

  it('a date-only duedate is 23:59 local time, all day', () => {
    const { item } = mappedItem(issue({ duedate: '2026-11-15' }));
    assert.equal(item.dueAt?.toISOString(), '2026-11-15T21:59:00.000Z');
    assert.equal(item.allDay, true);
  });

  it('no duedate means no dueAt and not all day', () => {
    const { item } = mappedItem(issue());
    assert.equal(item.dueAt ?? null, null);
    assert.equal(item.allDay ?? false, false);
  });

  it('a bad duedate is a failure with the issue id, not a throw', () => {
    assert.deepEqual(mapped(issue({ duedate: '15/11/2026' })), {
      failure: { externalId: '10101', code: 'bad_due_date' },
    });
  });

  it('an unknown status category is a failure', () => {
    assert.deepEqual(mapped(issue({ status: { name: 'Odd', statusCategory: { key: 'weird' } } })), {
      failure: { externalId: '10101', code: 'unknown_status' },
    });
  });

  it('a done issue is closed when its status category changed, never at updated', () => {
    const done = { name: 'Done', statusCategory: { key: 'done' } };
    const { item } = mappedItem(
      issue({ status: done, statuscategorychangedate: '2026-11-09T12:30:00.000+0000' }),
    );
    assert.equal(item.status, 'done');
    assert.equal(item.closedAt?.toISOString(), '2026-11-09T12:30:00.000Z');
    const unknown = mappedItem(issue({ status: done, resolutiondate: '2026-11-01T00:00:00.000Z' }));
    assert.equal(unknown.item.closedAt ?? null, null, 'no fallback to resolution date or updated');
    const open = mappedItem(issue({ statuscategorychangedate: '2026-11-09T12:30:00.000+0000' }));
    assert.equal(open.item.closedAt ?? null, null, 'not done: not closed');
  });

  it('assignee: the connected account becomes the owner; names are kept sorted', () => {
    const mine = mappedItem(issue({ assignee: { accountId: ME, displayName: 'Demo Dev' } })).item;
    assert.deepEqual(mine.assignees, [OWNER]);
    assert.deepEqual(mine.props?.['assigneeNames'], ['Demo Dev']);
    const theirs = mappedItem(
      issue({ assignee: { accountId: 'other', displayName: 'Dana' } }),
    ).item;
    assert.deepEqual(theirs.assignees ?? [], []);
    assert.deepEqual(theirs.props?.['assigneeNames'], ['Dana']);
  });

  it('without a key there is no usable URL (the engine reports missing_url)', () => {
    const { item } = mappedItem(issue({}, { key: undefined }));
    assert.equal(item.source.url, '');
    assert.equal(item.source.key, null);
  });

  it('does not depend on the clock: same input, same output', () => {
    assert.deepEqual(
      mapped(issue({ duedate: '2026-11-15' })),
      mapped(issue({ duedate: '2026-11-15' })),
    );
  });
});

/** A transport answering by path, so a test can script paging. */
function paged(answer: (url: URL) => unknown): Transport {
  return {
    send(request): Promise<HttpResponse> {
      return Promise.resolve({
        status: 200,
        headers: {},
        body: JSON.stringify(answer(new URL(request.url))),
      });
    },
  };
}

describe('paging does not stop on a missing isLast', () => {
  const ME_ANSWER = { accountId: ME, displayName: 'Demo Dev', timeZone: 'UTC' };

  async function drain(
    resource: string,
    transport: Transport,
  ): Promise<{ containers: number; items: number }> {
    const config = { baseUrl: BASE };
    const integration = {
      accountId: 'site-1',
      connectedBy: OWNER,
      config,
    } as unknown as IntegrationData;
    const generator = jiraAdapter.fetch(contextFor(integration, transport), resource, null);
    let containers = 0;
    let items = 0;
    for (;;) {
      const next = await generator.next();
      if (next.done === true) break;
      containers += next.value.containers.length;
      items += next.value.items.length;
    }
    return { containers, items };
  }

  it('projects: a full page without isLast is followed by the next page', async () => {
    const project = (n: number): object => ({
      id: String(n),
      key: `P${String(n)}`,
      name: `P${String(n)}`,
    });
    const transport = paged((url) => {
      if (url.pathname.endsWith('/project/search')) {
        const startAt = Number(url.searchParams.get('startAt'));
        const count = startAt === 0 ? 50 : 3;
        return { values: Array.from({ length: count }, (_, i) => project(startAt + i + 1)) };
      }
      return ME_ANSWER;
    });
    assert.equal((await drain('projects', transport)).containers, 53);
  });

  it('projects: a short page without isLast ends the listing', async () => {
    const transport = paged(() => ({ values: [{ id: '1', key: 'P1', name: 'P1' }] }));
    assert.equal((await drain('projects', transport)).containers, 1);
  });

  it('issues: a page token without isLast is followed', async () => {
    const issueOf = (id: string): object => ({
      id,
      key: `ADS-${id}`,
      fields: { summary: id, status: { statusCategory: { key: 'new' } }, project: { id: '1' } },
    });
    const transport = paged((url) => {
      if (url.pathname.endsWith('/search/jql')) {
        return url.searchParams.get('nextPageToken') === null
          ? { issues: [issueOf('1')], nextPageToken: 'T2' }
          : { issues: [issueOf('2')] };
      }
      return ME_ANSWER;
    });
    assert.equal((await drain('issues', transport)).items, 2);
  });
});

describe('jqlFor', () => {
  it('defaults to my open work plus what changed in 30 days', () => {
    assert.equal(
      jqlFor({}, null, 'Asia/Jerusalem'),
      'assignee = currentUser() AND (statusCategory != Done OR updated >= -30d)',
    );
  });

  it('uses config.jql', () => {
    assert.equal(jqlFor({ jql: 'project = ADS' }, null, 'UTC'), 'project = ADS');
  });

  it('incremental: appends the cursor in the Jira user zone, minute precision', () => {
    assert.equal(
      jqlFor({}, '2026-11-10T08:05:59.000Z', 'Asia/Jerusalem'),
      '(assignee = currentUser() AND (statusCategory != Done OR updated >= -30d)) AND updated >= "2026-11-10 10:05"',
    );
  });

  it('incremental: goes before ORDER BY', () => {
    assert.equal(
      jqlFor({ jql: 'project = ADS ORDER BY created DESC' }, '2026-11-10T08:05:00.000Z', 'UTC'),
      '(project = ADS) AND updated >= "2026-11-10 08:05" ORDER BY created DESC',
    );
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
    client: jiraAdapter.createClient(transport),
    now: FIXTURE_NOW,
    timeZone: TIME_ZONE,
    fullSyncDue: false,
  };
}

describe('jira adapter: engine runs over fixtures', () => {
  let kit: Kit;
  before(async () => {
    kit = await startKit('todolist_jira_test');
  });
  after(async () => {
    await kit.stop();
  });

  const config = { baseUrl: BASE };

  it('resources: containers first', () => {
    assert.deepEqual(jiraAdapter.resources({} as IntegrationData), ['projects', 'issues']);
  });

  it('v1 → v1 → v2: counts, the missing_url failure, closed and deleted', async () => {
    const s = await kit.setup('jira', { config });
    const first = await kit.run(s, jiraAdapter);
    assert.equal(first.status, 'partial');
    assert.deepEqual(first.counts, counts({ fetched: 10, inserted: 9, failed: 1 }));

    const containers = await kit.containers(s);
    const project = need(containers, 'project:10001');
    assert.deepEqual(
      [project.type, project.name, project.props],
      ['project', 'AutoDS', { key: 'ADS' }],
    );
    assert.equal(project.source.url, `${BASE}/browse/ADS`);
    assert.equal(project.topicId, 'work');

    const items = await kit.items(s);
    assert.equal(items.size, 9);
    const one = need(items, '10101');
    assert.equal(one.containerId, project.id);
    assert.deepEqual(one.assignees, [OWNER]);
    assert.equal(one.status, 'in_progress');
    assert.equal(need(items, '10108').status, 'done');
    assert.equal(need(items, '10106').assignees.length, 0, 'assigned to someone else');
    assert.ok(!items.has('10110'), 'no key, no link: not stored');

    const dueAt = (id: string): string | undefined => need(items, id).dueAt?.toISOString();
    assert.equal(dueAt('10104'), '2026-11-13T21:59:00.000Z', 'ADS-104 is due tomorrow 23:59 local');
    assert.equal(dueAt('10103'), '2026-11-12T21:59:00.000Z', 'ADS-103 is due today 23:59 local');
    assert.equal(dueAt('10107'), undefined);

    const again = await kit.run(s, jiraAdapter);
    assert.deepEqual(again.counts, counts({ fetched: 10, unchanged: 9, failed: 1 }));

    const v2 = await kit.run(s, jiraAdapter, { set: 'v2', later: true });
    assert.deepEqual(
      v2.counts,
      counts({ fetched: 9, updated: 2, unchanged: 6, closed: 1, deleted: 1, failed: 1 }),
    );
    const after = await kit.items(s);
    assert.equal(need(after, '10103').title, 'Update pricing rules docs (reviewed)');
    const closed = need(after, '10105');
    assert.equal(closed.status, 'done');
    assert.ok(closed.closedAt instanceof Date);
    assert.equal(closed.deletedAt, null);
    assert.ok(need(after, '10109').deletedAt instanceof Date, 'ADS-109 was removed at the source');
    assert.equal(need(after, '10101').deletedAt, null);
  });

  it('an incremental run (cursor stored, no full sync due) never sweeps', async () => {
    const s = await kit.setup('jira', { config });
    await kit.run(s, jiraAdapter);
    const v2 = await kit.run(s, jiraAdapter, { set: 'v2' });
    assert.equal(v2.counts.deleted, 0);
    assert.equal(need(await kit.items(s), '10109').deletedAt, null);
  });

  it('only GET requests, all under the configured site; the incremental JQL carries the cursor', async () => {
    const s = await kit.setup('jira', { config: { ...config, jql: 'project = ADS' } });
    const transport = await setTransport(jiraAdapter, 'v1');
    await kit.run(s, jiraAdapter, { transport });
    await kit.run(s, jiraAdapter, { transport });
    assert.ok(transport.calls.length > 6);
    for (const call of transport.calls) {
      assert.equal(call.method, 'GET');
      assert.equal(call.graphqlOperation, undefined);
      assert.equal(call.body, undefined);
      assert.ok(call.url.startsWith(`${BASE}/rest/api/3/`), call.url);
    }
    const jqls = transport.calls
      .filter((call) => call.url.includes('/search/jql'))
      .map((call) => new URL(call.url).searchParams)
      .filter((params) => params.get('nextPageToken') === null)
      .map((params) => params.get('jql'));
    assert.equal(jqls[0], 'project = ADS');
    assert.match(jqls[1] ?? '', /^\(project = ADS\) AND updated >= "\d{4}-\d\d-\d\d \d\d:\d\d"$/);
  });

  it('a real sync asks for every navigable field with their names and stores cf_* keys', async () => {
    const s = await kit.setup('jira', { config });
    const transport = await setTransport(jiraAdapter, 'v1');
    await kit.run(s, jiraAdapter, { transport });
    const search = transport.calls
      .filter((call) => call.url.includes('/search/jql'))
      .map((call) => new URL(call.url).searchParams)[0];
    const requested = (search?.get('fields') ?? '').split(',');
    assert.ok(requested.includes('*navigable'));
    assert.ok(requested.includes('customfield_10016'), 'the fixed fields stay');
    assert.equal(search?.get('expand'), 'names');

    const jira = need(await kit.items(s), '10101').props['jira'] as Record<string, unknown>;
    assert.equal(jira['cf_risk_level'], 'High', 'a single option');
    assert.equal(jira['cf_team_size'], 8, 'a number');
    assert.deepEqual(jira['cf_components_touched'], ['backend', 'api'], 'a list of options');
    assert.equal(jira['cf_reviewer'], 'Demo Dev', 'a user');
    assert.match(String(jira['cf_target_release_date']), /^\d{4}-\d\d-\d\d/, 'a date');
    assert.ok(!('cf_design_notes' in jira), 'rich text is skipped');
    assert.ok(
      !Object.keys(jira).some((key) => key.includes('token')),
      'a credential-like name is skipped',
    );
    // The fixed keys keep their own mapping.
    assert.equal(jira['storyPoints'], 3);
    assert.ok(!('cf_story_point_estimate' in jira));
  });

  it('caps custom fields at 25 per issue and text at 200 characters', () => {
    const fields: Record<string, unknown> = {};
    const names: Record<string, string> = {};
    for (let index = 0; index < 40; index += 1) {
      const id = `customfield_${String(20000 + index)}`;
      fields[id] = index;
      names[id] = `Field ${String(index).padStart(2, '0')}`;
    }
    fields['customfield_30000'] = 'x'.repeat(201);
    names['customfield_30000'] = 'Too long';
    const { item } = mappedItem(issue(fields, { names }));
    const jira = item.props?.['jira'] as Record<string, unknown>;
    assert.equal(Object.keys(jira).filter((key) => key.startsWith('cf_')).length, 25);
    assert.ok(!('cf_too_long' in jira));
  });

  it('test(): who am I, with the account id', async () => {
    const s = await kit.setup('jira', { config });
    const transport = await setTransport(jiraAdapter, 'v1');
    const result = await jiraAdapter.test?.(contextFor(s.integration, transport));
    assert.deepEqual(result, { accountLabel: 'Demo Dev', accountId: ME });
    assert.deepEqual(
      transport.calls.map((call) => [call.method, call.url]),
      [['GET', `${BASE}/rest/api/3/myself`]],
    );
  });

  it('live headers: Basic base64(email:token)', async () => {
    const s = await kit.setup('jira', { config });
    const seen: HttpRequest[] = [];
    const spy: Transport = {
      send(request) {
        seen.push(request);
        return Promise.resolve({
          status: 200,
          headers: {},
          body: JSON.stringify({ accountId: ME, displayName: 'Demo Dev' }),
        });
      },
    };
    await jiraAdapter.test?.(
      contextFor(s.integration, spy, { email: 'a@example.invalid', token: 'FAKE-token' }),
    );
    assert.equal(
      seen[0]?.headers['authorization'],
      `Basic ${Buffer.from('a@example.invalid:FAKE-token').toString('base64')}`,
    );
  });
});
