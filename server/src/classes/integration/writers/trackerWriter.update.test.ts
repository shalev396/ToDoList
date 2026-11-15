/**
 * The write client's updates (write-back, plan Addendum A1): the update bodies per provider (typed
 * fields only), the allow-list (exactly the update endpoints, each with its own method; Linear only
 * the named issueUpdate document), the exact requests sent, and how an answer maps to a result.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { HttpRequest, HttpResponse, Transport } from '../../../sync/http.js';
import {
  LINEAR_ISSUE_CREATE_DOCUMENT,
  LINEAR_ISSUE_UPDATE_DOCUMENT,
  clickupUpdateBody,
  createWriteClient,
  githubUpdateBody,
  guardedTransport,
  isAllowedCreate,
  isAllowedUpdate,
  isAllowedWrite,
  jiraPriorityName,
  jiraTransitionBody,
  jiraUpdateBody,
  linearUpdateInput,
  WriteRefusedError,
  type UpdateFields,
} from './trackerWriter.js';

const TZ = 'Asia/Jerusalem';
const CLOUD = '1324a887-45db-1bf4-1e99-ef0ff456d421';
const JIRA_BASE = `https://api.atlassian.com/ex/jira/${CLOUD}`;
const JIRA_BASES = [JIRA_BASE, 'https://mysite.atlassian.net'];
const SITE = { base: JIRA_BASE, siteUrl: 'https://acme.atlassian.net' };
const LINEAR_ID = '11111111-2222-4333-8444-555555555555';
const HEADERS = { authorization: 'Bearer FAKE-token-update' };
/** 20 Nov 2026, 10:00 UTC: 12:00 in Jerusalem. */
const DUE = new Date('2026-11-20T10:00:00Z');
const START = new Date('2026-11-18T07:30:00Z');

function respond(status: number, body: unknown = ''): HttpResponse {
  return { status, headers: {}, body: typeof body === 'string' ? body : JSON.stringify(body) };
}

function recorder(answer: HttpResponse | Error): { transport: Transport; sent: HttpRequest[] } {
  const sent: HttpRequest[] = [];
  return {
    sent,
    transport: {
      send(request): Promise<HttpResponse> {
        sent.push(request);
        return answer instanceof Error ? Promise.reject(answer) : Promise.resolve(answer);
      },
    },
  };
}

const fields = (over: Omit<UpdateFields, 'timeZone'>): UpdateFields => ({ timeZone: TZ, ...over });
const sentBody = (request: HttpRequest | undefined): unknown => JSON.parse(request?.body ?? 'null');

describe('update bodies (typed fields only)', () => {
  it('Jira: summary, the due date as the workspace’s day, the priority by its default name', () => {
    assert.deepEqual(
      jiraUpdateBody(fields({ title: 'Ship it', due: { at: DUE, allDay: false }, priority: 3 })),
      { fields: { summary: 'Ship it', duedate: '2026-11-20', priority: { name: 'High' } } },
    );
    assert.deepEqual(jiraUpdateBody(fields({ due: null })), { fields: { duedate: null } });
    assert.equal(jiraUpdateBody(fields({})), null);
    assert.deepEqual(
      [0, 1, 2, 3, 4, null].map((priority) => jiraPriorityName(priority)),
      ['Lowest', 'Low', 'Medium', 'High', 'Highest', null],
    );
    assert.throws(() => jiraUpdateBody(fields({ priority: null })), WriteRefusedError);
    assert.deepEqual(jiraTransitionBody('31'), { transition: { id: '31' } });
    assert.throws(() => jiraTransitionBody('31/../1'));
  });

  it('ClickUp: name, status by name, dates in milliseconds with their time flag, priority', () => {
    assert.deepEqual(
      clickupUpdateBody(
        fields({ title: 'Ship it', due: { at: DUE, allDay: true }, startAt: START, priority: 4 }),
        'in review',
      ),
      {
        name: 'Ship it',
        status: 'in review',
        due_date: DUE.getTime(),
        due_date_time: false,
        start_date: START.getTime(),
        start_date_time: true,
        priority: 1,
      },
    );
    assert.deepEqual(clickupUpdateBody(fields({ due: null, startAt: null, priority: null })), {
      due_date: null,
      start_date: null,
      priority: null,
    });
    // ClickUp has no lowest (0); a status name with a control character is never sent.
    assert.throws(() => clickupUpdateBody(fields({ priority: 0 })), WriteRefusedError);
    assert.throws(() => clickupUpdateBody(fields({}), 'done\nx'), WriteRefusedError);
  });

  it('Linear: title, the state Linear listed, the due date as a day, priority (none is 0)', () => {
    assert.deepEqual(
      linearUpdateInput(
        fields({ title: 'Ship it', due: { at: DUE, allDay: true }, priority: 4 }),
        LINEAR_ID,
      ),
      { title: 'Ship it', stateId: LINEAR_ID, dueDate: '2026-11-20', priority: 1 },
    );
    assert.deepEqual(linearUpdateInput(fields({ due: null, priority: null })), {
      dueDate: null,
      priority: 0,
    });
    assert.throws(() => linearUpdateInput(fields({ priority: 0 })), WriteRefusedError);
    assert.throws(() => linearUpdateInput(fields({}), 'not-a-state'));
  });

  it('GitHub: the title and the state, with why it closed', () => {
    assert.deepEqual(
      githubUpdateBody(fields({ title: 'Ship it' }), {
        state: 'closed',
        stateReason: 'not_planned',
      }),
      { title: 'Ship it', state: 'closed', state_reason: 'not_planned' },
    );
    assert.deepEqual(githubUpdateBody(fields({}), { state: 'open' }), { state: 'open' });
    assert.throws(() => githubUpdateBody(fields({ title: '   ' })), WriteRefusedError);
  });
});

describe('the allow-list: exactly the update endpoints', () => {
  const request = (
    method: HttpRequest['method'],
    url: string,
    extra: Partial<HttpRequest> = {},
  ): HttpRequest => ({ method, url, headers: {}, ...extra });
  const linear = (document: string, operation: string, extra: object = {}): HttpRequest =>
    request('POST', 'https://api.linear.app/graphql', {
      body: JSON.stringify({ query: document, variables: {}, ...extra }),
      graphqlOperation: operation,
    });

  it('allows each update with its own method, Jira only at the integration’s own sites', () => {
    for (const allowed of [
      request('PUT', `${JIRA_BASE}/rest/api/3/issue/10500`),
      request('PUT', 'https://mysite.atlassian.net/rest/api/3/issue/7'),
      request('POST', `${JIRA_BASE}/rest/api/3/issue/10500/transitions`),
      request('PUT', 'https://api.clickup.com/api/v2/task/86b0xyz9'),
      request('PATCH', 'https://api.github.com/repos/octo/hello/issues/12'),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate'),
    ]) {
      assert.equal(isAllowedUpdate(allowed, JIRA_BASES), true, `${allowed.method} ${allowed.url}`);
      assert.equal(isAllowedWrite(allowed, JIRA_BASES), true);
    }
  });

  it('refuses off-list paths, methods, queries and hosts', () => {
    for (const refused of [
      // Another site, or a host that only starts like one.
      request('PUT', 'https://other.atlassian.net/rest/api/3/issue/7'),
      request('PUT', 'https://mysite.atlassian.net.evil.example/rest/api/3/issue/7'),
      // Other Jira writes: comments, links, a delete, a transition by key, a query.
      request('PUT', `${JIRA_BASE}/rest/api/3/issue/10500/comment`),
      request('POST', `${JIRA_BASE}/rest/api/3/issue/10500/remotelink`),
      request('POST', `${JIRA_BASE}/rest/api/3/issue/ABC-1/transitions`),
      request('PUT', `${JIRA_BASE}/rest/api/3/issue/10500?notifyUsers=false`),
      request('PATCH', `${JIRA_BASE}/rest/api/3/issue/10500`),
      request('GET', `${JIRA_BASE}/rest/api/3/issue/10500/transitions`),
      // ClickUp: a list, a custom task id, a POST to a task, a sub-path.
      request('PUT', 'https://api.clickup.com/api/v2/list/901'),
      request('PUT', 'https://api.clickup.com/api/v2/task/DEV-12'),
      request('POST', 'https://api.clickup.com/api/v2/task/86b0xyz9'),
      request('PUT', 'https://api.clickup.com/api/v2/task/86b0xyz9/tag/x'),
      request('PUT', 'https://api.clickup.com/api/v2/task/86b0xyz9?custom_task_ids=true'),
      // GitHub: comments, a pull request, the repository, a PUT, `..`.
      request('PATCH', 'https://api.github.com/repos/octo/hello/issues/12/comments'),
      request('PATCH', 'https://api.github.com/repos/octo/hello/pulls/12'),
      request('PATCH', 'https://api.github.com/repos/octo/hello'),
      request('PUT', 'https://api.github.com/repos/octo/hello/issues/12'),
      request('PATCH', 'https://api.github.com/repos/octo/../issues/12'),
      request('PATCH', 'https://api.github.com/repos/octo/hello/issues/0'),
      request('PATCH', 'https://evil.example/repos/octo/hello/issues/12'),
    ]) {
      assert.equal(isAllowedUpdate(refused, JIRA_BASES), false, `${refused.method} ${refused.url}`);
      assert.equal(isAllowedWrite(refused, JIRA_BASES), false, `${refused.method} ${refused.url}`);
    }
    // Jira's own issue paths are refused without the integration's sites.
    assert.equal(isAllowedUpdate(request('PUT', `${JIRA_BASE}/rest/api/3/issue/1`)), false);
  });

  it('Linear: a mutation other than issueUpdate (and issueCreate) is refused', () => {
    for (const refused of [
      linear(
        'mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }',
        'IssueDelete',
      ),
      linear(
        'mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }',
        'IssueUpdate',
      ),
      linear(
        `${LINEAR_ISSUE_UPDATE_DOCUMENT}\nmutation X { issueDelete(id: "1") { success } }`,
        'IssueUpdate',
      ),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueCreate'),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', { operationName: 'IssueDelete' }),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', { extensions: {} }),
      request('POST', 'https://api.linear.app/graphql', {
        body: 'not json',
        graphqlOperation: 'IssueUpdate',
      }),
    ]) {
      assert.equal(isAllowedWrite(refused, JIRA_BASES), false, refused.body);
    }
    // The create is still the create, and only as a create.
    assert.equal(isAllowedCreate(linear(LINEAR_ISSUE_CREATE_DOCUMENT, 'IssueCreate')), true);
    assert.equal(isAllowedUpdate(linear(LINEAR_ISSUE_CREATE_DOCUMENT, 'IssueCreate')), false);
  });

  it('the guarded transport sends an allowed update once and never an off-list one', async () => {
    const { transport, sent } = recorder(respond(204));
    const guarded = guardedTransport(transport, JIRA_BASES);
    await assert.rejects(
      guarded.send(request('PUT', `${JIRA_BASE}/rest/api/3/issue/1/comment`)),
      WriteRefusedError,
    );
    assert.equal(sent.length, 0);
    await guarded.send(request('PUT', `${JIRA_BASE}/rest/api/3/issue/1`));
    assert.equal(sent.length, 1);
    assert.equal(guarded.maxRetries, 0);
  });
});

describe('sending an update', () => {
  it('Jira: one PUT of the fields and one POST of the transition, each answered 204', async () => {
    const { transport, sent } = recorder(respond(204));
    const client = createWriteClient(transport, JIRA_BASES);
    const body = jiraUpdateBody(fields({ title: 'Ship it' })) ?? {};
    assert.deepEqual(await client.updateJiraIssue(SITE, '10500', HEADERS, body), {
      kind: 'updated',
      record: null,
    });
    assert.deepEqual(
      await client.transitionJiraIssue(SITE, '10500', HEADERS, jiraTransitionBody('31')),
      { kind: 'updated', record: null },
    );
    assert.deepEqual(
      sent.map((request) => [request.method, request.url, sentBody(request)]),
      [
        ['PUT', `${JIRA_BASE}/rest/api/3/issue/10500`, { fields: { summary: 'Ship it' } }],
        ['POST', `${JIRA_BASE}/rest/api/3/issue/10500/transitions`, { transition: { id: '31' } }],
      ],
    );
    assert.equal(sent[0]?.headers['authorization'], HEADERS.authorization);
  });

  it('ClickUp, Linear and GitHub: the request, and the record their answer carries', async () => {
    const clickup = recorder(respond(200, { id: '86b0xyz9', name: 'Ship it' }));
    assert.deepEqual(
      await createWriteClient(clickup.transport).updateClickupTask('86b0xyz9', HEADERS, {
        name: 'Ship it',
      }),
      { kind: 'updated', record: { id: '86b0xyz9', name: 'Ship it' } },
    );
    assert.deepEqual(
      clickup.sent.map((request) => [request.method, request.url, sentBody(request)]),
      [['PUT', 'https://api.clickup.com/api/v2/task/86b0xyz9', { name: 'Ship it' }]],
    );

    const issue = { id: LINEAR_ID, title: 'Ship it', state: { name: 'Done', type: 'completed' } };
    const linear = recorder(respond(200, { data: { issueUpdate: { success: true, issue } } }));
    assert.deepEqual(
      await createWriteClient(linear.transport).updateLinearIssue(HEADERS, LINEAR_ID, {
        title: 'Ship it',
      }),
      { kind: 'updated', record: issue },
    );
    assert.equal(linear.sent[0]?.graphqlOperation, 'IssueUpdate');
    assert.deepEqual(sentBody(linear.sent[0]), {
      query: LINEAR_ISSUE_UPDATE_DOCUMENT,
      variables: { id: LINEAR_ID, input: { title: 'Ship it' } },
    });

    const github = recorder(respond(200, { number: 12, title: 'Ship it', state: 'open' }));
    assert.deepEqual(
      await createWriteClient(github.transport).updateGithubIssue('octo/hello', '12', HEADERS, {
        title: 'Ship it',
      }),
      { kind: 'updated', record: { number: 12, title: 'Ship it', state: 'open' } },
    );
    assert.deepEqual(
      github.sent.map((request) => [request.method, request.url]),
      [['PATCH', 'https://api.github.com/repos/octo/hello/issues/12']],
    );
  });

  it('classifies the answers: refused (4xx, a GraphQL error), unknown (5xx, no answer)', async () => {
    const run = (answer: HttpResponse | Error): Promise<unknown> =>
      createWriteClient(recorder(answer).transport).updateGithubIssue('octo/hello', '12', HEADERS, {
        title: 'x',
      });
    assert.deepEqual(await run(respond(401)), { kind: 'refused', reason: 'auth' });
    assert.deepEqual(await run(respond(403)), { kind: 'refused', reason: 'forbidden' });
    assert.deepEqual(await run(respond(422)), { kind: 'refused', reason: 'rejected' });
    assert.deepEqual(await run(respond(502)), { kind: 'unknown' });
    assert.deepEqual(await run(new Error('timeout')), { kind: 'unknown' });
    const linear = await createWriteClient(
      recorder(respond(200, { errors: [{ message: 'nope' }] })).transport,
    ).updateLinearIssue(HEADERS, LINEAR_ID, {});
    assert.deepEqual(linear, { kind: 'refused', reason: 'rejected' });
  });

  it('a path id that is not one is refused before anything is sent', async () => {
    const { transport, sent } = recorder(respond(204));
    const client = createWriteClient(transport, JIRA_BASES);
    await assert.rejects(client.updateJiraIssue(SITE, '1/../2', HEADERS, {}));
    await assert.rejects(client.updateClickupTask('86b0/../x', HEADERS, {}));
    await assert.rejects(client.updateGithubIssue('octo/hello', '12/comments', HEADERS, {}));
    await assert.rejects(client.updateLinearIssue(HEADERS, 'not-an-id', {}));
    assert.equal(sent.length, 0);
  });
});
