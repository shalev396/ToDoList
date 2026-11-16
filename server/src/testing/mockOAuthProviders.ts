/**
 * A local stand-in for the OAuth side of GitHub, Jira (Atlassian), ClickUp and Linear: authorize
 * (auto-consent), token (code and refresh grants), revoke, and the identity and resource calls
 * each provider needs after the grant. It serves tests (in process, on any port; the app points
 * at it with setOAuthBaseUrlForTests). Loopback only;
 * everything in memory; every token FAKE.
 *
 * Paths: `/<provider>/authorize`, `/token`, `/revoke` (Linear), and the API under
 * `/<provider>/api/...` (the endpoints of sync/providers/oauthEndpoints.ts, mock side).
 * - authorize approves as the provider's test account and redirects to the loopback
 *   `redirect_uri` with a code and the state; `nextAuthorize('deny')` answers
 *   `error=access_denied` once.
 * - token: the code grant (client secret, redirect URI and PKCE S256 checked; a code works once)
 *   and the refresh grant. Refresh tokens rotate (GitHub, Jira, Linear): the old one is refused
 *   once the new one has been issued. ClickUp tokens never expire and have no refresh grant.
 * - the API takes a live `Bearer` access token only (401 otherwise).
 * - POST /__reset clears codes and grants. GET /__state: counts only, never a token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { createServer, type IncomingMessage, type Server, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

export const MOCK_OAUTH_PORT = 3997;
export const MOCK_OAUTH_PROVIDERS = ['github', 'jira', 'clickup', 'linear'] as const;
export type MockOAuthProvider = (typeof MOCK_OAUTH_PROVIDERS)[number];

const CODE_TTL_MS = 10 * 60 * 1000;
const MAX_BODY_BYTES = 100_000;
const LOOPBACK_REDIRECT = /^http:\/\/(?:127\.0\.0\.1|localhost):\d{1,5}\//;
/** Access-token lifetime in seconds, by provider (0: it never expires). */
const ACCESS_TTL_S: Readonly<Record<MockOAuthProvider, number>> = {
  github: 28_800,
  jira: 3_600,
  clickup: 0,
  linear: 86_400,
};
const CLOUD_ID = '1324a887-45db-1bf4-1e99-ef0ff456d421';

export interface MockOAuthClient {
  clientId: string;
  clientSecret: string;
}

export interface MockOAuthOptions {
  /** Default 3997; 0 picks a free port (tests). */
  port?: number;
  /** Per provider; the default is `FAKE-<provider>-client-id` / `FAKE-<provider>-client-secret`. */
  clients?: Partial<Record<MockOAuthProvider, MockOAuthClient>>;
}

export const mockClientFor = (provider: MockOAuthProvider): MockOAuthClient => ({
  clientId: `FAKE-${provider}-client-id`,
  clientSecret: `FAKE-${provider}-client-secret`,
});

interface Grant {
  provider: MockOAuthProvider;
  /** The scopes granted, space separated (what the authorize request asked for). */
  scope: string;
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number | null;
  revoked: boolean;
}

interface Code {
  provider: MockOAuthProvider;
  scope: string;
  clientId: string;
  redirectUri: string;
  challenge: string | null;
  expiresAt: number;
  used: boolean;
}

export interface MockOAuth {
  /** e.g. http://127.0.0.1:3997: what setOAuthBaseUrlForTests takes. */
  url: string;
  /** The next authorize answers `error=access_denied` (once). */
  nextAuthorize(mode: 'deny'): void;
  /** Makes every live access token of the provider expired (the refresh token stays valid). */
  expireAccessTokens(provider: MockOAuthProvider): void;
  /** How many token-endpoint calls (code or refresh grants) the provider has served. */
  tokenCalls(provider: MockOAuthProvider): number;
  /** Tokens revoked at the provider. */
  revokedCount(provider: MockOAuthProvider): number;
  /**
   * The next create at the provider fails: with this HTTP status, or `drop` (the connection is
   * cut after the request was read: the caller cannot know whether it was created).
   */
  failNextCreate(provider: MockOAuthProvider, how: number | 'drop'): void;
  /** What the provider holds for creates: how many items were created, and the last one's input. */
  created(provider: MockOAuthProvider): { count: number; last: Record<string, unknown> | null };
  /** Every request the stand-in received, in order: its method and path (no query, no body). */
  requests(): readonly MockRequest[];
  close(): Promise<void>;
}

/** One request a stand-in received. */
export interface MockRequest {
  method: string;
  path: string;
}

const random = (): string => randomBytes(18).toString('base64url');

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json', 'cache-control': 'no-store' });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<Record<string, string>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  if (text === '') return {};
  if ((req.headers['content-type'] ?? '').includes('application/json')) {
    const parsed = JSON.parse(text) as Record<string, unknown>;
    return Object.fromEntries(Object.entries(parsed).map(([key, value]) => [key, String(value)]));
  }
  return Object.fromEntries(new URLSearchParams(text));
}

async function readJson(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).length;
    if (size > MAX_BODY_BYTES) throw new Error('body too large');
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString('utf8');
  return text === '' ? {} : (JSON.parse(text) as Record<string, unknown>);
}

export async function startMockOAuth(options: MockOAuthOptions = {}): Promise<MockOAuth> {
  const clients = (provider: MockOAuthProvider): MockOAuthClient =>
    options.clients?.[provider] ?? mockClientFor(provider);
  const codes = new Map<string, Code>();
  const grants: Grant[] = [];
  const calls: Record<MockOAuthProvider, number> = { github: 0, jira: 0, clickup: 0, linear: 0 };
  let deny = false;
  const failNext = new Map<MockOAuthProvider, number | 'drop'>();
  const made: Record<MockOAuthProvider, { count: number; last: Record<string, unknown> | null }> = {
    github: { count: 0, last: null },
    jira: { count: 0, last: null },
    clickup: { count: 0, last: null },
    linear: { count: 0, last: null },
  };
  const store = new Map<string, Record<string, unknown>>();

  function authorize(provider: MockOAuthProvider, url: URL, res: ServerResponse): void {
    const clientId = url.searchParams.get('client_id') ?? '';
    const redirectUri = url.searchParams.get('redirect_uri') ?? '';
    const state = url.searchParams.get('state') ?? '';
    if (clientId !== clients(provider).clientId || !LOOPBACK_REDIRECT.test(redirectUri)) {
      send(res, 400, { error: 'invalid_request' });
      return;
    }
    const target = new URL(redirectUri);
    target.searchParams.set('state', state);
    if (deny) {
      deny = false;
      target.searchParams.set('error', 'access_denied');
    } else {
      const code = `FAKE-code-${random()}`;
      codes.set(code, {
        provider,
        scope: (url.searchParams.get('scope') ?? '')
          .split(/[\s,]+/)
          .filter(Boolean)
          .join(' '),
        clientId,
        redirectUri,
        challenge: url.searchParams.get('code_challenge'),
        expiresAt: Date.now() + CODE_TTL_MS,
        used: false,
      });
      target.searchParams.set('code', code);
    }
    res.writeHead(302, { location: target.href });
    res.end();
  }

  const DEFAULT_SCOPE: Readonly<Record<MockOAuthProvider, string>> = {
    github: '',
    jira: 'read:jira-work read:jira-user read:me offline_access',
    clickup: '',
    linear: 'read',
  };

  function issue(provider: MockOAuthProvider, withRefresh: boolean, scope = ''): Grant {
    const ttl = ACCESS_TTL_S[provider];
    const grant: Grant = {
      provider,
      scope: scope === '' ? DEFAULT_SCOPE[provider] : scope,
      accessToken: `FAKE-${provider}-access-${random()}`,
      refreshToken: withRefresh ? `FAKE-${provider}-refresh-${random()}` : null,
      expiresAt: ttl === 0 ? null : Date.now() + ttl * 1000,
      revoked: false,
    };
    grants.push(grant);
    return grant;
  }

  const tokenBody = (provider: MockOAuthProvider, grant: Grant): Record<string, unknown> => ({
    access_token: grant.accessToken,
    token_type: 'bearer',
    ...(ACCESS_TTL_S[provider] === 0 ? {} : { expires_in: ACCESS_TTL_S[provider] }),
    ...(grant.refreshToken === null ? {} : { refresh_token: grant.refreshToken }),
    scope: grant.scope,
  });

  async function token(
    provider: MockOAuthProvider,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const form = await readBody(req);
    const client = clients(provider);
    if (form['client_id'] !== client.clientId || form['client_secret'] !== client.clientSecret) {
      send(res, 401, { error: 'invalid_client' });
      return;
    }
    calls[provider] += 1;
    if (form['grant_type'] === 'authorization_code') {
      const entry = codes.get(form['code'] ?? '');
      const challengeOk =
        entry?.challenge === null ||
        entry?.challenge === undefined ||
        createHash('sha256')
          .update(form['code_verifier'] ?? '', 'ascii')
          .digest('base64url') === entry.challenge;
      if (
        entry?.provider !== provider ||
        entry.used ||
        entry.expiresAt < Date.now() ||
        entry.redirectUri !== form['redirect_uri'] ||
        !challengeOk
      ) {
        send(res, 400, { error: 'invalid_grant' });
        return;
      }
      entry.used = true;
      send(res, 200, tokenBody(provider, issue(provider, provider !== 'clickup', entry.scope)));
      return;
    }
    if (form['grant_type'] === 'refresh_token' && provider !== 'clickup') {
      const old = grants.find(
        (grant) => grant.provider === provider && grant.refreshToken === form['refresh_token'],
      );
      if (old === undefined || old.revoked) {
        send(res, 400, { error: 'invalid_grant' });
        return;
      }
      // Rotation: the refresh token just used is spent.
      old.refreshToken = null;
      old.revoked = true;
      send(res, 200, tokenBody(provider, issue(provider, true, old.scope)));
      return;
    }
    send(res, 400, { error: 'unsupported_grant_type' });
  }

  async function revoke(
    provider: MockOAuthProvider,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const form = await readBody(req);
    const target = grants.find(
      (grant) =>
        grant.provider === provider &&
        (grant.accessToken === form['token'] || grant.refreshToken === form['token']),
    );
    if (target === undefined || target.revoked) {
      send(res, 400, { error: 'invalid_token' });
      return;
    }
    target.revoked = true;
    send(res, 200, {});
  }

  function liveGrant(provider: MockOAuthProvider, req: IncomingMessage): Grant | null {
    const header = req.headers.authorization ?? '';
    const bearerToken = header.startsWith('Bearer ') ? header.slice(7) : '';
    return (
      grants.find(
        (grant) =>
          grant.provider === provider &&
          grant.accessToken === bearerToken &&
          !grant.revoked &&
          (grant.expiresAt === null || grant.expiresAt > Date.now()),
      ) ?? null
    );
  }

  const LINEAR_TEAM = '4a1b2c3d-0000-4000-8000-000000000001';
  const LINEAR_PROJECT = '4a1b2c3d-0000-4000-8000-000000000002';
  const LINEAR_STATE = '4a1b2c3d-0000-4000-8000-000000000003';
  const LINEAR_STATE_2 = '4a1b2c3d-0000-4000-8000-000000000004';

  /** An injected failure for the next create, or false when there is none. */
  function injected(
    provider: MockOAuthProvider,
    req: IncomingMessage,
    res: ServerResponse,
  ): boolean {
    const how = failNext.get(provider);
    if (how === undefined) return false;
    failNext.delete(provider);
    if (how === 'drop') req.socket.destroy();
    else send(res, how, { error: 'injected' });
    return true;
  }

  function recordCreate(provider: MockOAuthProvider, input: Record<string, unknown>): number {
    made[provider].count += 1;
    made[provider].last = input;
    return made[provider].count;
  }

  /**
   * What the create funnels and the creates themselves need (H5): the choices of each provider,
   * the create endpoint, and the read-back of the created item. Returns false for any other path.
   */
  async function createApi(
    provider: MockOAuthProvider,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
    grant: Grant,
  ): Promise<boolean> {
    const url = new URL(req.url ?? '/', 'http://127.0.0.1');
    const method = req.method ?? 'GET';
    const scopes = grant.scope.split(' ');
    if (provider === 'github') {
      const repo = /^\/repos\/([^/]+)\/([^/]+)(\/labels|\/issues(?:\/(\d+))?)?$/.exec(path);
      if (path === '/user/installations' && method === 'GET') {
        send(res, 200, { installations: [{ id: 1 }] });
      } else if (
        (path === '/user/installations/1/repositories' || path === '/user/repos') &&
        method === 'GET'
      ) {
        const repos = [{ full_name: 'mock-org/mock-repo', archived: false, has_issues: true }];
        send(res, 200, path === '/user/repos' ? repos : { repositories: repos });
      } else if (repo !== null && repo[3] === '/labels' && method === 'GET') {
        send(res, 200, [{ name: 'bug' }, { name: 'chore' }]);
      } else if (repo !== null && repo[3] === undefined && method === 'GET') {
        send(res, 200, { node_id: 'R_mock', full_name: `${repo[1] ?? ''}/${repo[2] ?? ''}` });
      } else if (repo !== null && repo[3] === '/issues' && method === 'POST') {
        const body = await readJson(req);
        if (injected(provider, req, res)) return true;
        const number = recordCreate(provider, body);
        const full = `${repo[1] ?? ''}/${repo[2] ?? ''}`;
        const issue = {
          node_id: `I_mock_${String(number)}`,
          number,
          title: body['title'],
          body: body['body'] ?? null,
          html_url: `https://github.com/${full}/issues/${String(number)}`,
          state: 'open',
          user: { login: 'Mock-User' },
          assignees: [],
          labels: (Array.isArray(body['labels']) ? (body['labels'] as string[]) : []).map(
            (name) => ({ name }),
          ),
          updated_at: new Date().toISOString(),
        };
        store.set(`github:${full}#${String(number)}`, issue);
        send(res, 201, issue);
      } else if (repo?.[4] !== undefined && method === 'GET') {
        const found = store.get(`github:${repo[1] ?? ''}/${repo[2] ?? ''}#${repo[4]}`);
        send(res, found === undefined ? 404 : 200, found ?? { message: 'Not Found' });
      } else {
        return false;
      }
      return true;
    }
    if (provider === 'jira') {
      const base = `/ex/jira/${CLOUD_ID}/rest/api/3`;
      if (!path.startsWith(`${base}/`)) return false;
      const rest = path.slice(base.length);
      if (rest === '/project/search' && url.searchParams.get('action') === 'create') {
        send(res, 200, {
          values: [{ id: '10001', key: 'MOCK', name: 'Mock Project' }],
          isLast: true,
        });
      } else if (rest === '/issue/createmeta/10001/issuetypes') {
        send(res, 200, {
          issueTypes: [
            { id: '10002', name: 'Task' },
            { id: '10003', name: 'Bug' },
            { id: '10004', name: 'Sub-task', subtask: true },
          ],
        });
      } else if (/^\/issue\/createmeta\/10001\/issuetypes\/\d+$/.test(rest)) {
        send(res, 200, {
          values: [
            { fieldId: 'summary', name: 'Summary' },
            {
              fieldId: 'customfield_10100',
              name: 'Team',
              schema: {
                custom: 'com.atlassian.jira.plugin.system.customfieldtypes:atlassian-team',
              },
              allowedValues: [
                { id: 'team-backend', name: 'Backend' },
                { id: 'team-web', name: 'Web' },
              ],
            },
          ],
        });
      } else if (rest === '/issue' && method === 'POST') {
        const body = await readJson(req);
        if (injected(provider, req, res)) return true;
        if (!scopes.includes('write:jira-work')) {
          send(res, 403, { errorMessages: ['scope does not match'] });
          return true;
        }
        const number = recordCreate(provider, body);
        const fields = (body['fields'] ?? {}) as Record<string, unknown>;
        const created = {
          id: String(10500 + number),
          key: `MOCK-${String(number)}`,
          fields: {
            summary: fields['summary'],
            duedate: fields['duedate'] ?? null,
            status: { name: 'To Do', statusCategory: { key: 'new' } },
            issuetype: { name: 'Task' },
            project: { id: '10001', key: 'MOCK' },
            assignee: fields['assignee'] ?? null,
            labels: [],
            updated: new Date().toISOString(),
          },
        };
        store.set(`jira:${created.key}`, created);
        send(res, 201, { id: created.id, key: created.key, self: 'x' });
      } else if (/^\/issue\/[A-Z]+-\d+$/.test(rest) && method === 'GET') {
        const found = store.get(`jira:${rest.slice('/issue/'.length)}`);
        send(res, found === undefined ? 404 : 200, found ?? {});
      } else {
        return false;
      }
      return true;
    }
    if (provider === 'clickup') {
      if (path === '/team/9001/space') {
        send(res, 200, { spaces: [{ id: '90010', name: 'Mock Space' }] });
      } else if (path === '/space/90010/folder') {
        send(res, 200, { folders: [{ id: '90100', name: 'Mock Folder' }] });
      } else if (path === '/folder/90100/list') {
        send(res, 200, { lists: [{ id: '90200', name: 'Mock List' }] });
      } else if (path === '/space/90010/list') {
        send(res, 200, { lists: [{ id: '90201', name: 'Loose List' }] });
      } else if (/^\/list\/\d+\/task$/.test(path) && method === 'POST') {
        const body = await readJson(req);
        if (injected(provider, req, res)) return true;
        const number = recordCreate(provider, body);
        const id = `86mock${String(number)}`;
        const task = {
          id,
          name: body['name'],
          text_content: body['description'] ?? null,
          status: { status: 'to do', type: 'open' },
          url: `https://app.clickup.com/t/${id}`,
          due_date: body['due_date'] === undefined ? null : JSON.stringify(body['due_date']),
          due_date_time: body['due_date_time'],
          list: { id: path.split('/')[2] },
          space: { id: '90010' },
          date_updated: String(Date.now()),
          assignees: [],
          tags: [],
        };
        store.set(`clickup:${id}`, task);
        send(res, 200, task);
      } else if (/^\/task\/[A-Za-z0-9]+$/.test(path) && method === 'GET') {
        const found = store.get(`clickup:${path.slice('/task/'.length)}`);
        send(res, found === undefined ? 404 : 200, found ?? {});
      } else {
        return false;
      }
      return true;
    }
    // Linear
    if (path !== '/graphql' || method !== 'POST') return false;
    const body = await readJson(req);
    const query = typeof body['query'] === 'string' ? body['query'] : '';
    const variables = (body['variables'] ?? {}) as Record<string, unknown>;
    if (query.includes('issueCreate')) {
      if (injected(provider, req, res)) return true;
      if (!scopes.includes('issues:create') && !scopes.includes('write')) {
        send(res, 200, { errors: [{ message: 'forbidden', extensions: { code: 'FORBIDDEN' } }] });
        return true;
      }
      const input = (variables['input'] ?? {}) as Record<string, unknown>;
      const number = recordCreate(provider, input);
      const id = `5b2c3d4e-0000-4000-8000-${String(number).padStart(12, '0')}`;
      const identifier = `MOCK-${String(number)}`;
      const issue = {
        id,
        identifier,
        title: input['title'],
        description: input['description'] ?? null,
        url: `https://linear.app/mock/issue/${identifier}/x`,
        priority: input['priority'] ?? 0,
        dueDate: input['dueDate'] ?? null,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        state: { name: 'Todo', type: 'unstarted' },
        team: { id: LINEAR_TEAM, key: 'MOCK', name: 'Mock Team' },
        project: null,
        assignee: null,
        labels: { nodes: [] },
      };
      store.set(`linear:${id}`, issue);
      send(res, 200, {
        data: { issueCreate: { success: true, issue: { id, identifier, url: issue.url } } },
      });
    } else if (query.includes('CreateTeams')) {
      send(res, 200, {
        data: { teams: { nodes: [{ id: LINEAR_TEAM, key: 'MOCK', name: 'Mock Team' }] } },
      });
    } else if (query.includes('CreateProjects')) {
      send(res, 200, {
        data: { team: { projects: { nodes: [{ id: LINEAR_PROJECT, name: 'Mock Project' }] } } },
      });
    } else if (query.includes('CreateStates')) {
      send(res, 200, {
        data: {
          team: {
            defaultIssueState: { id: LINEAR_STATE },
            states: {
              nodes: [
                { id: LINEAR_STATE, name: 'Todo', type: 'unstarted' },
                { id: LINEAR_STATE_2, name: 'In Progress', type: 'started' },
              ],
            },
          },
        },
      });
    } else if (query.includes('viewer')) {
      send(res, 200, {
        data: {
          viewer: { id: 'mock-linear-user', name: 'Mock Linear', email: 'mock@example.test' },
        },
      });
    } else if (query.includes('CreatedIssue')) {
      send(res, 200, { data: { issue: store.get(`linear:${String(variables['id'])}`) ?? null } });
    } else {
      return false;
    }
    return true;
  }

  const SITE = {
    id: CLOUD_ID,
    name: 'Mock Site',
    url: `https://mock-site.example.test`,
    scopes: ['read:jira-work', 'read:jira-user'],
    avatarUrl: '',
  };

  async function api(
    provider: MockOAuthProvider,
    path: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const grant = liveGrant(provider, req);
    if (grant === null) {
      send(res, 401, { error: 'unauthorized' });
      return;
    }
    if (await createApi(provider, path, req, res, grant)) return;
    if (provider === 'github' && path === '/user') {
      send(res, 200, { login: 'Mock-User', id: 1 });
    } else if (provider === 'github' && path === '/graphql') {
      send(res, 200, { data: {} });
    } else if (
      provider === 'github' &&
      /^\/(user\/repos|orgs\/[^/]+\/repos|repos\/.+)$/.test(path)
    ) {
      send(res, 200, []);
    } else if (provider === 'jira' && path === '/me') {
      send(res, 200, { account_id: 'mock-atlassian-account', email: 'mock@example.test' });
    } else if (provider === 'jira' && path === '/oauth/token/accessible-resources') {
      send(res, 200, [SITE]);
    } else if (provider === 'jira' && path === `/ex/jira/${CLOUD_ID}/rest/api/3/myself`) {
      send(res, 200, { accountId: 'mock-atlassian-account', displayName: 'Mock', timeZone: 'UTC' });
    } else if (provider === 'jira' && path === `/ex/jira/${CLOUD_ID}/rest/api/3/project/search`) {
      send(res, 200, { values: [], isLast: true });
    } else if (provider === 'jira' && path === `/ex/jira/${CLOUD_ID}/rest/api/3/search/jql`) {
      send(res, 200, { issues: [], isLast: true });
    } else if (provider === 'clickup' && path === '/user') {
      send(res, 200, { user: { id: 4242, username: 'mock-clickup', email: 'mock@example.test' } });
    } else if (provider === 'clickup' && path === '/team') {
      send(res, 200, { teams: [{ id: '9001', name: 'Mock Workspace' }] });
    } else if (provider === 'clickup' && path.startsWith('/team/')) {
      send(res, 200, { spaces: [], tasks: [] });
    } else if (provider === 'linear' && path === '/graphql') {
      const body = await readBody(req);
      const query = body['query'] ?? '';
      if (query.includes('viewer')) {
        send(res, 200, {
          data: {
            viewer: { id: 'mock-linear-user', name: 'Mock Linear', email: 'mock@example.test' },
          },
        });
      } else {
        send(res, 200, { data: {} });
      }
    } else {
      send(res, 404, { error: 'not_found' });
    }
  }

  const received: MockRequest[] = [];
  const server: Server = createServer((req, res) => {
    void (async (): Promise<void> => {
      try {
        const url = new URL(req.url ?? '/', 'http://127.0.0.1');
        received.push({ method: req.method ?? 'GET', path: url.pathname });
        if (req.method === 'POST' && url.pathname === '/__reset') {
          codes.clear();
          grants.length = 0;
          send(res, 200, {});
          return;
        }
        if (req.method === 'GET' && url.pathname === '/__state') {
          send(res, 200, { codes: codes.size, grants: grants.length });
          return;
        }
        const [, name, kind, ...rest] = url.pathname.split('/');
        const provider = MOCK_OAUTH_PROVIDERS.find((known) => known === name);
        if (provider === undefined) {
          send(res, 404, { error: 'not_found' });
        } else if (kind === 'authorize' && req.method === 'GET') {
          authorize(provider, url, res);
        } else if (kind === 'token' && req.method === 'POST') {
          await token(provider, req, res);
        } else if (kind === 'revoke' && req.method === 'POST' && provider === 'linear') {
          await revoke(provider, req, res);
        } else if (kind === 'api') {
          await api(provider, `/${rest.join('/')}`, req, res);
        } else {
          send(res, 404, { error: 'not_found' });
        }
      } catch {
        send(res, 500, { error: 'mock_error' });
      }
    })();
  });

  await new Promise<void>((resolve) => {
    server.listen(options.port ?? MOCK_OAUTH_PORT, '127.0.0.1', resolve);
  });
  const { port } = server.address() as AddressInfo;

  return {
    url: `http://127.0.0.1:${String(port)}`,
    requests: (): readonly MockRequest[] => [...received],
    nextAuthorize: (): void => {
      deny = true;
    },
    expireAccessTokens: (provider): void => {
      for (const grant of grants) {
        if (grant.provider === provider && grant.expiresAt !== null) grant.expiresAt = 1;
      }
    },
    tokenCalls: (provider) => calls[provider],
    failNextCreate: (provider, how): void => {
      failNext.set(provider, how);
    },
    created: (provider) => ({ ...made[provider] }),
    revokedCount: (provider) =>
      grants.filter((grant) => grant.provider === provider && grant.revoked).length,
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => {
          resolve();
        });
      }),
  };
}

/**
 * Points the app at `mock` through the test seams (call after the harness started): the four
 * providers' endpoints, their app secrets (the mock's FAKE clients) and the OAuth callbacks, which
 * go to `apiBaseUrl` (the API under test, a loopback origin the mock redirects to).
 */
export async function pointAppAtMockOAuth(mock: MockOAuth, apiBaseUrl: string): Promise<void> {
  const { setOAuthBaseUrlForTests } = await import('../sync/providers/oauthEndpoints.js');
  const { setAppSecretsForTests } = await import('../services/appSecrets.js');
  const { setCallbackOriginForTests } = await import('../services/oauth/common.js');
  setOAuthBaseUrlForTests(mock.url);
  setAppSecretsForTests(
    Object.fromEntries(
      MOCK_OAUTH_PROVIDERS.map((provider) => [`oauth-${provider}`, mockClientFor(provider)]),
    ),
  );
  setCallbackOriginForTests(apiBaseUrl);
}
