/**
 * The write client (H5): request mapping per provider, the allow-list (only the exact create
 * endpoints; Linear only the named issueCreate document), path-id validation, how an answer
 * (or no answer) maps to a result, and that nothing secret ever surfaces.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  DestinationRefusedError,
  type HttpRequest,
  type HttpResponse,
  type Transport,
} from '../../sync/http.js';
import {
  LINEAR_ISSUE_CREATE_DOCUMENT,
  clickupPriority,
  clickupTaskBody,
  cleanTitle,
  createWriteClient,
  githubIssueBody,
  guardedTransport,
  isAllowedCreate,
  jiraIssueBody,
  linearIssueInput,
  toAdf,
  type CreateFields,
} from './writeClient.js';
import { splitRepo } from './ids.js';

const FIELDS: CreateFields = {
  title: '  Buy milk  ',
  description: 'Two litres\nSemi-skimmed',
  dueAt: new Date('2026-11-20T10:00:00Z'),
  allDay: false,
  priority: 4,
  timeZone: 'Asia/Jerusalem',
};
const TOKEN = 'FAKE-token-do-not-leak';
const HEADERS = { authorization: `Bearer ${TOKEN}` };
const CLOUD = '1324a887-45db-1bf4-1e99-ef0ff456d421';
const JIRA_BASES = [`https://api.atlassian.com/ex/jira/${CLOUD}`, 'https://mysite.atlassian.net'];
const LINEAR_TEAM = '11111111-2222-4333-8444-555555555555';

function respond(
  status: number,
  body: unknown,
  headers: Record<string, string> = {},
): HttpResponse {
  return { status, headers, body: typeof body === 'string' ? body : JSON.stringify(body) };
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

describe('request mapping', () => {
  it('trims the title and keeps at most 255 characters', () => {
    assert.equal(cleanTitle('  hi  '), 'hi');
    assert.equal(cleanTitle('   '), null);
    assert.equal(cleanTitle('x'.repeat(400))?.length, 255);
  });

  it('Jira: ids from typed fields, the description as ADF, the due date as a date', () => {
    const body = jiraIssueBody(FIELDS, {
      projectId: '10001',
      issueTypeId: '10002',
      team: { fieldId: 'customfield_10100', id: 'team-uuid-1' },
      assigneeAccountId: 'acct-1',
    });
    assert.deepEqual(body, {
      fields: {
        project: { id: '10001' },
        issuetype: { id: '10002' },
        summary: 'Buy milk',
        description: toAdf('Two litres\nSemi-skimmed'),
        duedate: '2026-11-20',
        customfield_10100: 'team-uuid-1',
        assignee: { accountId: 'acct-1' },
      },
    });
    assert.deepEqual(toAdf('a\n\nb'), {
      type: 'doc',
      version: 1,
      content: [
        { type: 'paragraph', content: [{ type: 'text', text: 'a' }] },
        { type: 'paragraph' },
        { type: 'paragraph', content: [{ type: 'text', text: 'b' }] },
      ],
    });
  });

  it('Jira: a path-like id or a field name that is not customfield_<n> is a 400', () => {
    assert.throws(() => jiraIssueBody(FIELDS, { projectId: '1/../2', issueTypeId: '1' }));
    assert.throws(() =>
      jiraIssueBody(FIELDS, {
        projectId: '1',
        issueTypeId: '1',
        team: { fieldId: 'project', id: 'x' },
      }),
    );
  });

  it('ClickUp: name, description, due date with its time, priority on its own scale', () => {
    assert.deepEqual(clickupTaskBody(FIELDS), {
      name: 'Buy milk',
      description: 'Two litres\nSemi-skimmed',
      due_date: FIELDS.dueAt?.getTime(),
      due_date_time: true,
      priority: 1,
    });
    assert.equal(clickupPriority(1), 4);
    assert.equal(clickupPriority(0), null);
    assert.equal(
      clickupTaskBody({ ...FIELDS, dueAt: null, priority: null, description: null })['due_date'],
      undefined,
    );
  });

  it('Linear: team, title, date-only due date, priority, optional project and state', () => {
    assert.deepEqual(
      linearIssueInput(FIELDS, {
        teamId: LINEAR_TEAM,
        projectId: LINEAR_TEAM,
        stateId: LINEAR_TEAM,
      }),
      {
        teamId: LINEAR_TEAM,
        title: 'Buy milk',
        description: 'Two litres\nSemi-skimmed',
        dueDate: '2026-11-20',
        priority: 1,
        projectId: LINEAR_TEAM,
        stateId: LINEAR_TEAM,
      },
    );
    assert.throws(() => linearIssueInput(FIELDS, { teamId: 'not-a-uuid' }));
  });

  it('GitHub: title, body and a bounded label list; repositories are owner/name only', () => {
    assert.deepEqual(githubIssueBody(FIELDS, ['bug', ' ', 'x'.repeat(80)]), {
      title: 'Buy milk',
      body: 'Two litres\nSemi-skimmed',
      labels: ['bug', 'x'.repeat(50)],
    });
    assert.deepEqual(splitRepo('octo/hello.world'), { owner: 'octo', name: 'hello.world' });
    for (const bad of ['octo', 'octo/..', 'octo/a/b', '../x', 'octo/a?b', 'octo/a b', 7]) {
      assert.throws(() => splitRepo(bad), `${String(bad)} is refused`);
    }
  });
});

describe('the allow-list (tightened)', () => {
  const post = (url: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
    method: 'POST',
    url,
    headers: {},
    ...extra,
  });

  it('binds Jira to the integration’s own sites, and refuses . and .. as a repository', () => {
    assert.equal(
      isAllowedCreate(post('https://other.atlassian.net/rest/api/3/issue'), JIRA_BASES),
      false,
    );
    assert.equal(isAllowedCreate(post('https://mysite.atlassian.net/rest/api/3/issue')), false);
    assert.equal(isAllowedCreate(post('https://api.github.com/repos/octo/../issues')), false);
    assert.equal(isAllowedCreate(post('https://api.github.com/repos/octo/./issues')), false);
  });

  it('Linear carries only {query, variables}', () => {
    const request = (extra: Record<string, unknown>): HttpRequest =>
      post('https://api.linear.app/graphql', {
        body: JSON.stringify({ query: LINEAR_ISSUE_CREATE_DOCUMENT, variables: {}, ...extra }),
        graphqlOperation: 'IssueCreate',
      });
    assert.equal(isAllowedCreate(request({})), true);
    assert.equal(isAllowedCreate(request({ operationName: 'x' })), false);
    assert.equal(isAllowedCreate(request({ extensions: {} })), false);
  });
});

describe('the allow-list', () => {
  const post = (url: string, extra: Partial<HttpRequest> = {}): HttpRequest => ({
    method: 'POST',
    url,
    headers: {},
    ...extra,
  });
  const issueCreate = (overrides: Partial<HttpRequest> = {}): HttpRequest =>
    post('https://api.linear.app/graphql', {
      body: JSON.stringify({ query: LINEAR_ISSUE_CREATE_DOCUMENT, variables: {} }),
      graphqlOperation: 'IssueCreate',
      ...overrides,
    });

  it('allows exactly the create endpoints', () => {
    for (const url of [
      `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue`,
      'https://mysite.atlassian.net/rest/api/3/issue',
      'https://api.clickup.com/api/v2/list/901/task',
      'https://api.github.com/repos/octo/hello/issues',
    ]) {
      assert.equal(isAllowedCreate(post(url), JIRA_BASES), true, url);
    }
    assert.equal(isAllowedCreate(issueCreate()), true);
  });

  it('refuses everything else: other methods, paths, queries and hosts', () => {
    const refused: HttpRequest[] = [
      { method: 'GET', url: 'https://api.github.com/repos/octo/hello/issues', headers: {} },
      post(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/10001`),
      post(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue/bulk`),
      post(`https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/project`),
      post('https://mysite.atlassian.net/rest/api/3/issue?x=1'),
      post('http://mysite.atlassian.net/rest/api/3/issue'),
      post('https://api.clickup.com/api/v2/list/9/task/1'),
      post('https://api.clickup.com/api/v2/task/1'),
      post('https://api.clickup.com/api/v2/list/a/task'),
      post('https://api.github.com/repos/octo/hello/issues/3/comments'),
      post('https://api.github.com/repos/octo/hello/pulls'),
      post('https://api.github.com/graphql'),
      post('https://evil.example/repos/octo/hello/issues'),
      post('https://api.linear.app/oauth/token'),
    ];
    for (const request of refused) {
      assert.equal(isAllowedCreate(request, JIRA_BASES), false, request.url);
    }
  });

  it('Linear accepts only the named issueCreate document', () => {
    for (const request of [
      issueCreate({
        body: JSON.stringify({ query: 'mutation { issueDelete(id: "x") { success } }' }),
      }),
      issueCreate({ body: JSON.stringify({ query: `${LINEAR_ISSUE_CREATE_DOCUMENT} ` }) }),
      issueCreate({ graphqlOperation: 'IssueDelete' }),
      issueCreate({ body: 'not json' }),
      { ...issueCreate(), body: '' },
      post('https://api.linear.app/graphql', { body: '{}' }),
    ]) {
      assert.equal(isAllowedCreate(request), false);
    }
  });

  it('the guarded transport never lets a refused request reach the inner one', async () => {
    const { transport, sent } = recorder(respond(200, {}));
    const guarded = guardedTransport(transport);
    await assert.rejects(
      guarded.send({ method: 'GET', url: 'https://api.github.com/user', headers: {} }),
      /Refused/,
    );
    assert.equal(sent.length, 0);
    assert.equal(guarded.maxRetries, 0);
  });
});

describe('sending', () => {
  it('Jira: 201 gives the key and a browse link; the request is a single POST', async () => {
    const { transport, sent } = recorder(respond(201, { id: '10500', key: 'ABC-123', self: 'x' }));
    const result = await createWriteClient(transport, JIRA_BASES).createJiraIssue(
      {
        base: `https://api.atlassian.com/ex/jira/${CLOUD}`,
        siteUrl: 'https://acme.atlassian.net/',
      },
      HEADERS,
      jiraIssueBody(FIELDS, { projectId: '1', issueTypeId: '2' }),
    );
    assert.deepEqual(result, {
      kind: 'created',
      record: { id: '10500', key: 'ABC-123', url: 'https://acme.atlassian.net/browse/ABC-123' },
    });
    assert.equal(sent.length, 1);
    assert.equal(sent[0]?.method, 'POST');
    assert.equal(sent.at(0)?.url, `https://api.atlassian.com/ex/jira/${CLOUD}/rest/api/3/issue`);
  });

  it('ClickUp, Linear and GitHub read their own answers', async () => {
    const clickup = await createWriteClient(
      recorder(respond(200, { id: 'abc123', url: 'https://app.clickup.com/t/abc123' })).transport,
    ).createClickupTask('901', HEADERS, clickupTaskBody(FIELDS));
    assert.deepEqual(clickup, {
      kind: 'created',
      record: { id: 'abc123', key: null, url: 'https://app.clickup.com/t/abc123' },
    });
    const linear = await createWriteClient(
      recorder(
        respond(200, {
          data: {
            issueCreate: {
              success: true,
              issue: { id: 'lin-1', identifier: 'ENG-7', url: 'https://linear.app/x/issue/ENG-7' },
            },
          },
        }),
      ).transport,
    ).createLinearIssue(HEADERS, linearIssueInput(FIELDS, { teamId: LINEAR_TEAM }));
    assert.deepEqual(linear, {
      kind: 'created',
      record: { id: 'lin-1', key: 'ENG-7', url: 'https://linear.app/x/issue/ENG-7' },
    });
    const github = await createWriteClient(
      recorder(respond(201, { number: 12, html_url: 'https://github.com/octo/hello/issues/12' }))
        .transport,
    ).createGithubIssue('octo/hello', HEADERS, githubIssueBody(FIELDS));
    assert.deepEqual(github, {
      kind: 'created',
      record: { id: '12', key: 'octo/hello#12', url: 'https://github.com/octo/hello/issues/12' },
    });
  });

  it('classifies answers: 401 auth, 403 forbidden, 429 and GitHub rate limits, 4xx rejected', async () => {
    const run = async (status: number, headers: Record<string, string> = {}): Promise<unknown> =>
      createWriteClient(
        recorder(respond(status, { message: 'nope' }, headers)).transport,
      ).createGithubIssue('octo/hello', HEADERS, githubIssueBody(FIELDS));
    assert.deepEqual(await run(401), { kind: 'refused', reason: 'auth' });
    assert.deepEqual(await run(403), { kind: 'refused', reason: 'forbidden' });
    assert.deepEqual(await run(403, { 'x-ratelimit-remaining': '0' }), {
      kind: 'refused',
      reason: 'rate_limited',
    });
    assert.deepEqual(await run(429), { kind: 'refused', reason: 'rate_limited' });
    assert.deepEqual(await run(422), { kind: 'refused', reason: 'rejected' });
  });

  it('sent but unanswered is unknown: a timeout, a 5xx, a body that is not an answer', async () => {
    const create = async (answer: HttpResponse | Error): Promise<unknown> =>
      createWriteClient(recorder(answer).transport).createClickupTask(
        '901',
        HEADERS,
        clickupTaskBody(FIELDS),
      );
    assert.deepEqual(await create(new Error('timeout')), { kind: 'unknown' });
    assert.deepEqual(await create(respond(502, 'bad gateway')), { kind: 'unknown' });
    assert.deepEqual(await create(respond(200, 'not json')), { kind: 'unknown' });
    assert.deepEqual(await create(respond(200, { nothing: true })), { kind: 'unknown' });
  });

  it('a destination netGuard refused was never sent: refused, not unknown', async () => {
    const result = await createWriteClient(
      recorder(new DestinationRefusedError()).transport,
    ).createClickupTask('901', HEADERS, clickupTaskBody(FIELDS));
    assert.deepEqual(result, { kind: 'refused', reason: 'unreachable' });
  });

  it('a ClickUp list id with a path in it is refused before anything is sent', async () => {
    const { transport, sent } = recorder(respond(200, {}));
    await assert.rejects(createWriteClient(transport).createClickupTask('1/../2', HEADERS, {}));
    assert.equal(sent.length, 0);
  });

  it('no result carries the token or the provider text', async () => {
    const answers = [
      respond(403, { message: `leak ${TOKEN}` }),
      new Error(`boom ${TOKEN}`),
      respond(500, TOKEN),
    ];
    for (const answer of answers) {
      const result = await createWriteClient(recorder(answer).transport).createGithubIssue(
        'octo/hello',
        HEADERS,
        githubIssueBody(FIELDS),
      );
      assert.ok(!JSON.stringify(result).includes(TOKEN));
    }
  });
});
