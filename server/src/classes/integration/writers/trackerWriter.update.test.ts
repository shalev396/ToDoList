/**
 * The write client's updates (write-back, plan Addendum A1): the update bodies per provider (typed
 * fields only), the allow-list (exactly the update endpoints, each with its own method, and each
 * BODY only the keys its builder sends; Linear only the named issueUpdate document), the exact
 * requests sent, and how an answer maps to a result.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { HttpRequest, HttpResponse, Transport } from '../../../sync/http.js';
import type { UpdateFields } from '../writeBack.js';
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
/** 20 Nov 2026, 23:30 in Jerusalem (21:30 UTC): still the 20th there. */
const LATE = new Date('2026-11-20T21:30:00Z');
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
  it('Jira: summary, the due date as the workspace’s day, the priority by the id Jira allows', () => {
    assert.deepEqual(
      jiraUpdateBody(
        fields({ title: 'Ship it', due: { at: DUE, allDay: false }, priority: 3 }),
        '2',
      ),
      { fields: { summary: 'Ship it', duedate: '2026-11-20', priority: { id: '2' } } },
    );
    assert.deepEqual(jiraUpdateBody(fields({ due: null })), { fields: { duedate: null } });
    assert.equal(jiraUpdateBody(fields({})), null);
    assert.deepEqual(
      [0, 1, 2, 3, 4, null].map((priority) => jiraPriorityName(priority)),
      ['Lowest', 'Low', 'Medium', 'High', 'Highest', null],
    );
    // A priority is only ever sent by an allowed id.
    assert.throws(() => jiraUpdateBody(fields({ priority: 3 })), WriteRefusedError);
    assert.throws(() => jiraUpdateBody(fields({ priority: 3 }), '2/../1'));
    assert.deepEqual(jiraTransitionBody('31'), { transition: { id: '31' } });
    assert.throws(() => jiraTransitionBody('31/../1'));
  });

  it('ClickUp: name, status by name, dates in milliseconds (a day at its noon), priority', () => {
    assert.deepEqual(
      clickupUpdateBody(
        fields({ title: 'Ship it', due: { at: LATE, allDay: true }, startAt: START, priority: 4 }),
        'in review',
      ),
      {
        name: 'Ship it',
        status: 'in review',
        // The 20th at noon in the workspace's zone: the same day wherever ClickUp shows it.
        due_date: new Date('2026-11-20T10:00:00Z').getTime(),
        due_date_time: false,
        start_date: START.getTime(),
        start_date_time: true,
        priority: 1,
      },
    );
    assert.deepEqual(clickupUpdateBody(fields({ due: { at: LATE, allDay: false } })), {
      due_date: LATE.getTime(),
      due_date_time: true,
    });
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

describe('the allow-list: exactly the update endpoints and bodies', () => {
  const request = (method: HttpRequest['method'], url: string, body?: unknown): HttpRequest => ({
    method,
    url,
    headers: {},
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  });
  const linear = (
    document: string,
    operation: string,
    variables: unknown = { id: LINEAR_ID, input: { title: 'x' } },
    extra: object = {},
  ): HttpRequest => ({
    method: 'POST',
    url: 'https://api.linear.app/graphql',
    headers: {},
    body: JSON.stringify({ query: document, variables, ...extra }),
    graphqlOperation: operation,
  });
  const JIRA_ISSUE = `${JIRA_BASE}/rest/api/3/issue/10500`;
  const CLICKUP_TASK = 'https://api.clickup.com/api/v2/task/86b0xyz9';
  const GITHUB_ISSUE = 'https://api.github.com/repos/octo/hello/issues/12';

  it('allows each update with its own method and its builder’s body, Jira only at its own sites', () => {
    for (const allowed of [
      request('PUT', JIRA_ISSUE, {
        fields: { summary: 'x', duedate: '2026-11-20', priority: { id: '2' } },
      }),
      request('PUT', 'https://mysite.atlassian.net/rest/api/3/issue/7', {
        fields: { duedate: null },
      }),
      request('POST', `${JIRA_ISSUE}/transitions`, { transition: { id: '31' } }),
      request('PUT', CLICKUP_TASK, {
        name: 'x',
        status: 'done',
        due_date: 1,
        due_date_time: false,
        start_date: null,
        start_date_time: true,
        priority: null,
      }),
      request('PATCH', GITHUB_ISSUE, { title: 'x', state: 'closed', state_reason: 'completed' }),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', {
        id: LINEAR_ID,
        input: { title: 'x', stateId: LINEAR_ID, dueDate: null, priority: 0 },
      }),
    ]) {
      assert.equal(isAllowedUpdate(allowed, JIRA_BASES), true, `${allowed.method} ${allowed.url}`);
      assert.equal(isAllowedWrite(allowed, JIRA_BASES), true);
    }
  });

  it('refuses a body with any key its builder never sends: trash, archive, body, assignees, a move', () => {
    for (const refused of [
      // Linear: trashed, a team move, an assignee, an extra variable.
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', {
        id: LINEAR_ID,
        input: { trashed: true },
      }),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', {
        id: LINEAR_ID,
        input: { title: 'x', teamId: LINEAR_ID },
      }),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', {
        id: LINEAR_ID,
        input: { assigneeId: LINEAR_ID },
      }),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', {
        id: LINEAR_ID,
        input: { title: 'x' },
        extra: 1,
      }),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', { id: LINEAR_ID, input: {} }),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', { input: { title: 'x' } }),
      // ClickUp: archived, assignees, a parent move, an empty body.
      request('PUT', CLICKUP_TASK, { archived: true }),
      request('PUT', CLICKUP_TASK, { name: 'x', assignees: { add: [1] } }),
      request('PUT', CLICKUP_TASK, { parent: 'abc' }),
      request('PUT', CLICKUP_TASK, {}),
      request('PUT', CLICKUP_TASK),
      // GitHub: the body, assignees, labels, a milestone, the lock.
      request('PATCH', GITHUB_ISSUE, { title: 'x', body: '' }),
      request('PATCH', GITHUB_ISSUE, { assignees: [], labels: [], milestone: null }),
      request('PATCH', GITHUB_ISSUE, { state: 'closed', locked: true }),
      // Jira: a project move, an issue type, an `update` operation, a priority by name, a property.
      request('PUT', JIRA_ISSUE, { fields: { project: { id: '1' }, issuetype: { id: '2' } } }),
      request('PUT', JIRA_ISSUE, { fields: { summary: 'x' }, update: { labels: [{ set: [] }] } }),
      request('PUT', JIRA_ISSUE, { fields: { priority: { name: 'High' } } }),
      request('PUT', JIRA_ISSUE, { fields: { summary: 'x', labels: [] } }),
      request('PUT', JIRA_ISSUE, { fields: {}, properties: [] }),
      request('PUT', JIRA_ISSUE, { fields: {} }),
      // A transition with fields, an update, or a comment.
      request('POST', `${JIRA_ISSUE}/transitions`, {
        transition: { id: '31' },
        fields: { resolution: { name: 'Done' } },
      }),
      request('POST', `${JIRA_ISSUE}/transitions`, { transition: { id: '31', looped: true } }),
      request('POST', `${JIRA_ISSUE}/transitions`, { transition: { id: 31 } }),
      request('POST', `${JIRA_ISSUE}/transitions`, 'not json'),
    ]) {
      assert.equal(
        isAllowedWrite(refused, JIRA_BASES),
        false,
        `${refused.method} ${refused.body ?? ''}`,
      );
    }
  });

  it('refuses off-list paths, methods, queries and hosts', () => {
    const body = { fields: { summary: 'x' } };
    for (const refused of [
      // Another site, or a host that only starts like one.
      request('PUT', 'https://other.atlassian.net/rest/api/3/issue/7', body),
      request('PUT', 'https://mysite.atlassian.net.evil.example/rest/api/3/issue/7', body),
      // Other Jira writes: comments, links, a transition by key, a query, another method.
      request('PUT', `${JIRA_ISSUE}/comment`, body),
      request('POST', `${JIRA_ISSUE}/remotelink`, body),
      request('POST', `${JIRA_BASE}/rest/api/3/issue/ABC-1/transitions`, {
        transition: { id: '31' },
      }),
      request('PUT', `${JIRA_ISSUE}?notifyUsers=false`, body),
      request('PATCH', JIRA_ISSUE, body),
      request('GET', `${JIRA_ISSUE}/transitions`),
      // ClickUp: a list, a custom task id, a POST to a task, a sub-path, a query.
      request('PUT', 'https://api.clickup.com/api/v2/list/901', { name: 'x' }),
      request('PUT', 'https://api.clickup.com/api/v2/task/DEV-12', { name: 'x' }),
      request('POST', CLICKUP_TASK, { name: 'x' }),
      request('PUT', `${CLICKUP_TASK}/tag/x`, { name: 'x' }),
      request('PUT', `${CLICKUP_TASK}?custom_task_ids=true`, { name: 'x' }),
      // GitHub: comments, a pull request, the repository, a PUT, `..`, number 0, another host.
      request('PATCH', `${GITHUB_ISSUE}/comments`, { title: 'x' }),
      request('PATCH', 'https://api.github.com/repos/octo/hello/pulls/12', { title: 'x' }),
      request('PATCH', 'https://api.github.com/repos/octo/hello', { title: 'x' }),
      request('PUT', GITHUB_ISSUE, { title: 'x' }),
      request('PATCH', 'https://api.github.com/repos/octo/../issues/12', { title: 'x' }),
      request('PATCH', 'https://api.github.com/repos/octo/hello/issues/0', { title: 'x' }),
      request('PATCH', 'https://evil.example/repos/octo/hello/issues/12', { title: 'x' }),
    ]) {
      assert.equal(isAllowedWrite(refused, JIRA_BASES), false, `${refused.method} ${refused.url}`);
    }
    // Jira's own issue paths are refused without the integration's sites.
    assert.equal(isAllowedUpdate(request('PUT', `${JIRA_BASE}/rest/api/3/issue/1`, body)), false);
  });

  it('Linear: a mutation other than issueUpdate (and issueCreate) is refused', () => {
    const issueDelete = 'mutation IssueDelete($id: String!) { issueDelete(id: $id) { success } }';
    for (const refused of [
      linear(issueDelete, 'IssueDelete'),
      linear(issueDelete, 'IssueUpdate'),
      linear(
        `${LINEAR_ISSUE_UPDATE_DOCUMENT}\nmutation X { issueDelete(id: "1") { success } }`,
        'IssueUpdate',
      ),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueCreate'),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', undefined, {
        operationName: 'IssueDelete',
      }),
      linear(LINEAR_ISSUE_UPDATE_DOCUMENT, 'IssueUpdate', undefined, { extensions: {} }),
      {
        method: 'POST' as const,
        url: 'https://api.linear.app/graphql',
        headers: {},
        body: 'not json',
        graphqlOperation: 'IssueUpdate',
      },
    ]) {
      assert.equal(isAllowedWrite(refused, JIRA_BASES), false, refused.body);
    }
    // The create is still the create, and only as a create.
    const create = linear(LINEAR_ISSUE_CREATE_DOCUMENT, 'IssueCreate', {});
    assert.equal(isAllowedCreate(create), true);
    assert.equal(isAllowedUpdate(create), false);
  });

  it('the guarded transport sends an allowed update once and never an off-list one', async () => {
    const { transport, sent } = recorder(respond(204));
    const guarded = guardedTransport(transport, JIRA_BASES);
    await assert.rejects(
      guarded.send(request('PUT', `${JIRA_ISSUE}/comment`, { fields: { summary: 'x' } })),
      WriteRefusedError,
    );
    await assert.rejects(
      guarded.send(request('PUT', JIRA_ISSUE, { fields: { project: { id: '1' } } })),
      WriteRefusedError,
    );
    assert.equal(sent.length, 0);
    await guarded.send(request('PUT', JIRA_ISSUE, { fields: { summary: 'x' } }));
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

  it('classifies the answers: gone (404, 410), refused (4xx, a GraphQL error), unknown (5xx, none)', async () => {
    const run = (answer: HttpResponse | Error): Promise<unknown> =>
      createWriteClient(recorder(answer).transport).updateGithubIssue('octo/hello', '12', HEADERS, {
        title: 'x',
      });
    assert.deepEqual(await run(respond(404)), { kind: 'refused', reason: 'not_found' });
    assert.deepEqual(await run(respond(410)), { kind: 'refused', reason: 'not_found' });
    assert.deepEqual(await run(respond(401)), { kind: 'refused', reason: 'auth' });
    assert.deepEqual(await run(respond(403)), { kind: 'refused', reason: 'forbidden' });
    assert.deepEqual(await run(respond(422)), { kind: 'refused', reason: 'rejected' });
    assert.deepEqual(await run(respond(502)), { kind: 'unknown' });
    assert.deepEqual(await run(new Error('timeout')), { kind: 'unknown' });
    const linear = await createWriteClient(
      recorder(respond(200, { errors: [{ message: 'nope' }] })).transport,
    ).updateLinearIssue(HEADERS, LINEAR_ID, { title: 'x' });
    assert.deepEqual(linear, { kind: 'refused', reason: 'rejected' });
    // A create still reads a 404 as rejected (its answers are unchanged).
    const created = await createWriteClient(recorder(respond(404)).transport).createGithubIssue(
      'octo/hello',
      HEADERS,
      { title: 'x' },
    );
    assert.deepEqual(created, { kind: 'refused', reason: 'rejected' });
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
