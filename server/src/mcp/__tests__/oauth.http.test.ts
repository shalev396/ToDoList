/**
 * MCP sign-in over HTTP: discovery, register, authorize, the consent API, token, refresh and
 * revoke, then the MCP endpoints with the tokens that came out. The browser's part (login and
 * consent) goes through the private API with a test ID token.
 */
import { createHash, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { loginForTests } from '../../testing/apiHarness.js';
import { testSubForEmail } from '../../testing/testAuth.js';
import type { AgentScope } from '../../types/domain.js';
import { MCP_HEADERS, startMcpHarness, type McpHarness } from './helpers/mcpHarness.js';

let h: McpHarness;
let issuer: string;
let resource: string;
let resourceReadonly: string;

const REDIRECT = 'https://claude.example/cb';
const DEFAULT_SCOPE = 'read items:write builder:write';

interface Json {
  status: number;
  headers: Headers;
  text: string;
  body: Record<string, unknown> | null;
}

async function request(
  method: string,
  path: string,
  options: { token?: string; json?: unknown; form?: Record<string, string> } = {},
): Promise<Json> {
  const headers: Record<string, string> = {};
  let body: string | undefined;
  if (options.json !== undefined) {
    headers['content-type'] = 'application/json';
    body = JSON.stringify(options.json);
  } else if (options.form !== undefined) {
    headers['content-type'] = 'application/x-www-form-urlencoded';
    body = new URLSearchParams(options.form).toString();
  }
  if (options.token !== undefined) headers['authorization'] = `Bearer ${options.token}`;
  const response = await fetch(`${h.base}${path}`, {
    method,
    headers,
    redirect: 'manual',
    ...(body === undefined ? {} : { body }),
  });
  const text = await response.text();
  let parsed: Record<string, unknown> | null = null;
  try {
    parsed = text === '' ? null : (JSON.parse(text) as Record<string, unknown>);
  } catch {
    parsed = null;
  }
  return { status: response.status, headers: response.headers, text, body: parsed };
}

interface Member {
  id: string;
  token: string;
}

interface World {
  workspaceId: string;
  owner: Member;
  editor: Member;
  viewer: Member;
}

async function member(email: string): Promise<Member> {
  const { getUserRepository } = await import('../../models/index.js');
  const user = await (
    await getUserRepository()
  ).upsert({
    cognitoSub: testSubForEmail(email),
    email,
    name: email.split('@')[0] ?? email,
    lastLoginAt: new Date(),
  });
  const { token } = await loginForTests(email);
  return { id: user.id, token };
}

async function newWorld(label: string): Promise<World> {
  const owner = await member(`${label}-owner@example.test`);
  const editor = await member(`${label}-editor@example.test`);
  const viewer = await member(`${label}-viewer@example.test`);
  const created = await request('POST', '/api/private/workspaces', {
    token: owner.token,
    json: { name: `Team ${label}` },
  });
  assert.equal(created.status, 201, created.text);
  const workspaceId = (created.body?.['data'] as { id: string }).id;
  const { getMembershipRepository } = await import('../../models/index.js');
  const memberships = await getMembershipRepository();
  await memberships.create(workspaceId, { userId: editor.id, role: 'editor' });
  await memberships.create(workspaceId, { userId: viewer.id, role: 'viewer' });
  return { workspaceId, owner, editor, viewer };
}

async function registerClient(): Promise<string> {
  const res = await request('POST', '/api/mcp/oauth/register', {
    json: { client_name: 'Claude Desktop', redirect_uris: [REDIRECT] },
  });
  assert.equal(res.status, 201, res.text);
  return res.body?.['client_id'] as string;
}

function newVerifier(): string {
  return randomBytes(32).toString('base64url');
}

function challengeOf(verifier: string): string {
  return createHash('sha256').update(verifier).digest('base64url');
}

/** Starts an authorization request and answers its id. */
async function authorize(
  clientId: string,
  verifier: string,
  extra: Record<string, string> = {},
): Promise<string> {
  const query = new URLSearchParams({
    response_type: 'code',
    client_id: clientId,
    redirect_uri: REDIRECT,
    code_challenge: challengeOf(verifier),
    code_challenge_method: 'S256',
    state: 'xyz',
    ...extra,
  });
  const res = await request('GET', `/api/mcp/oauth/authorize?${query.toString()}`);
  assert.equal(res.status, 302, res.text);
  const location = new URL(res.headers.get('location') ?? '');
  return location.searchParams.get('request') ?? '';
}

async function approve(
  requestId: string,
  who: Member,
  workspaceId: string,
  scopes: AgentScope[] = ['read', 'items:write', 'builder:write'],
): Promise<URL> {
  const res = await request('POST', `/api/private/mcp-oauth/requests/${requestId}/approve`, {
    token: who.token,
    json: { workspaceId, scopes, name: 'Claude' },
  });
  assert.equal(res.status, 200, res.text);
  return new URL((res.body?.['data'] as { redirectTo: string }).redirectTo);
}

async function exchange(clientId: string, code: string, verifier: string): Promise<Json> {
  return request('POST', '/api/mcp/oauth/token', {
    form: {
      grant_type: 'authorization_code',
      code,
      code_verifier: verifier,
      client_id: clientId,
      redirect_uri: REDIRECT,
    },
  });
}

interface Tokens {
  clientId: string;
  access: string;
  refresh: string;
}

/** The whole sign-in for one member. */
async function signIn(
  who: Member,
  workspaceId: string,
  options: { resource?: string; scopes?: AgentScope[] } = {},
): Promise<Tokens> {
  const clientId = await registerClient();
  const verifier = newVerifier();
  const id = await authorize(
    clientId,
    verifier,
    options.resource === undefined ? {} : { resource: options.resource },
  );
  const redirect = await approve(id, who, workspaceId, options.scopes);
  const code = redirect.searchParams.get('code') ?? '';
  const res = await exchange(clientId, code, verifier);
  assert.equal(res.status, 200, res.text);
  return {
    clientId,
    access: res.body?.['access_token'] as string,
    refresh: res.body?.['refresh_token'] as string,
  };
}

const LIST = { jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} };

function toolsList(path: string, token: string): ReturnType<McpHarness['post']> {
  return h.post(path, LIST, { ...MCP_HEADERS, authorization: `Bearer ${token}` });
}

before(async () => {
  h = await startMcpHarness('todolist_mcp_oauth_http_test', { rateLimits: true });
  const urls = await import('../oauth/urls.js');
  issuer = urls.mcpIssuer();
  resource = urls.mcpResource(false);
  resourceReadonly = urls.mcpResource(true);
});

after(async () => {
  await h.stop();
});

describe('discovery', () => {
  it('all four AS metadata URLs and both resource-metadata forms answer the same documents', async () => {
    const asUrls = [
      '/api/mcp/oauth/.well-known/oauth-authorization-server',
      '/api/mcp/oauth/.well-known/openid-configuration',
      '/.well-known/oauth-authorization-server/api/mcp/oauth',
      '/.well-known/openid-configuration/api/mcp/oauth',
    ];
    const documents = [];
    for (const url of asUrls) {
      const res = await request('GET', url);
      assert.equal(res.status, 200, url);
      documents.push(res.body);
    }
    for (const document of documents) assert.deepEqual(document, documents[0]);
    const { AGENT_SCOPES } = await import('../../types/domain.js');
    assert.deepEqual(documents[0], {
      issuer,
      authorization_endpoint: `${issuer}/authorize`,
      token_endpoint: `${issuer}/token`,
      registration_endpoint: `${issuer}/register`,
      revocation_endpoint: `${issuer}/revoke`,
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['none'],
      client_id_metadata_document_supported: true,
      scopes_supported: [...AGENT_SCOPES],
    });

    const { READ_ONLY_SCOPES } = await import('../auth/scopes.js');
    for (const [readonly, forms] of [
      [
        false,
        ['/api/mcp/oauth/resource-metadata', '/.well-known/oauth-protected-resource/api/mcp'],
      ],
      [
        true,
        [
          '/api/mcp/oauth/resource-metadata/readonly',
          '/.well-known/oauth-protected-resource/api/mcp/readonly',
        ],
      ],
    ] as const) {
      const expected = {
        resource: readonly ? resourceReadonly : resource,
        authorization_servers: [issuer],
        scopes_supported: readonly ? [...READ_ONLY_SCOPES] : [...AGENT_SCOPES],
        bearer_methods_supported: ['header'],
      };
      for (const url of forms) {
        const res = await request('GET', url);
        assert.equal(res.status, 200, url);
        assert.deepEqual(res.body, expected, url);
      }
    }
  });

  it('a 401 from /api/mcp points to resource metadata and suggests the default scopes', async () => {
    const none = await h.post('/api/mcp', LIST);
    assert.equal(none.status, 401);
    assert.equal(
      none.headers.get('www-authenticate'),
      `Bearer realm="todolist-mcp", resource_metadata="${issuer}/resource-metadata", scope="${DEFAULT_SCOPE}"`,
    );
    const bad = await toolsList('/api/mcp/readonly', `elo_${'a'.repeat(43)}`);
    assert.equal(bad.status, 401);
    assert.equal(
      bad.headers.get('www-authenticate'),
      `Bearer realm="todolist-mcp", resource_metadata="${issuer}/resource-metadata/readonly", scope="${DEFAULT_SCOPE}", error="invalid_token"`,
    );
  });
});

describe('the sign-in flow', () => {
  it('full flow over HTTP: register → authorize → login → approve → token → tools/list works', async () => {
    const world = await newWorld('flow');
    const clientId = await registerClient();
    const verifier = newVerifier();
    const id = await authorize(clientId, verifier);

    const view = await request('GET', `/api/private/mcp-oauth/requests/${id}`, {
      token: world.editor.token,
    });
    assert.equal(view.status, 200, view.text);
    const data = view.body?.['data'] as {
      clientName: string;
      workspaces: { id: string; role: string }[];
    };
    assert.equal(data.clientName, 'Claude Desktop');
    assert.equal(data.workspaces[0]?.id, world.workspaceId);

    const redirect = await approve(id, world.editor, world.workspaceId);
    assert.equal(redirect.origin + redirect.pathname, REDIRECT);
    assert.equal(redirect.searchParams.get('state'), 'xyz');
    assert.equal(redirect.searchParams.get('iss'), issuer);

    const res = await exchange(clientId, redirect.searchParams.get('code') ?? '', verifier);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.body?.['token_type'], 'Bearer');
    assert.equal(res.body['expires_in'], 3600);
    assert.equal(res.body['scope'], DEFAULT_SCOPE);
    const access = res.body['access_token'] as string;
    assert.match(access, /^elo_/);
    assert.match(res.body['refresh_token'] as string, /^elr_/);

    const tools = await toolsList('/api/mcp', access);
    assert.equal(tools.status, 200, tools.text);
    const client = await h.connect(access);
    assert.ok((await client.listTools()).tools.length > 0);
  });

  it('deny sends the member back to the client with access_denied', async () => {
    const world = await newWorld('deny');
    const id = await authorize(await registerClient(), newVerifier());
    const res = await request('POST', `/api/private/mcp-oauth/requests/${id}/deny`, {
      token: world.viewer.token,
      json: {},
    });
    assert.equal(res.status, 200, res.text);
    const target = new URL((res.body?.['data'] as { redirectTo: string }).redirectTo);
    assert.equal(target.searchParams.get('error'), 'access_denied');
  });

  it('authorize with an unknown redirect_uri is a 400 text page, never a redirect', async () => {
    const clientId = await registerClient();
    const query = new URLSearchParams({
      response_type: 'code',
      client_id: clientId,
      redirect_uri: 'https://evil.example/cb',
      code_challenge: challengeOf(newVerifier()),
      code_challenge_method: 'S256',
    });
    const res = await request('GET', `/api/mcp/oauth/authorize?${query.toString()}`);
    assert.equal(res.status, 400);
    assert.match(res.headers.get('content-type') ?? '', /^text\/plain/);
    assert.equal(res.headers.get('location'), null);
  });

  it('a readonly grant is refused on /api/mcp and works on /api/mcp/readonly', async () => {
    const world = await newWorld('readonly');
    const { access } = await signIn(world.editor, world.workspaceId, {
      resource: resourceReadonly,
      scopes: ['read'],
    });
    assert.equal((await toolsList('/api/mcp', access)).status, 401);
    assert.equal((await toolsList('/api/mcp/readonly', access)).status, 200);

    const full = await signIn(world.editor, world.workspaceId);
    assert.equal((await toolsList('/api/mcp', full.access)).status, 200);
    assert.equal((await toolsList('/api/mcp/readonly', full.access)).status, 401);
  });

  it('refresh over HTTP rotates; a malformed grant_type is unsupported_grant_type', async () => {
    const world = await newWorld('refresh');
    const first = await signIn(world.editor, world.workspaceId);
    const res = await request('POST', '/api/mcp/oauth/token', {
      form: {
        grant_type: 'refresh_token',
        refresh_token: first.refresh,
        client_id: first.clientId,
      },
    });
    assert.equal(res.status, 200, res.text);
    const next = res.body?.['access_token'] as string;
    assert.notEqual(next, first.access);
    assert.notEqual(res.body?.['refresh_token'], first.refresh);
    assert.equal((await toolsList('/api/mcp', next)).status, 200);

    const odd = await request('POST', '/api/mcp/oauth/token', {
      form: { grant_type: 'password', client_id: first.clientId },
    });
    assert.equal(odd.status, 400);
    assert.equal(odd.body?.['error'], 'unsupported_grant_type');

    const missing = await request('POST', '/api/mcp/oauth/token', { form: {} });
    assert.equal(missing.status, 400);
    assert.equal(missing.body?.['error'], 'invalid_request');

    const wrongClient = await request('POST', '/api/mcp/oauth/token', {
      form: { grant_type: 'refresh_token', refresh_token: 'nope', client_id: first.clientId },
    });
    assert.equal(wrongClient.status, 400);
    assert.equal(wrongClient.body?.['error'], 'invalid_grant');
  });

  it("removing the member stops their access token and refresh token at once; another member's grant keeps working", async () => {
    const world = await newWorld('removal');
    const editor = await signIn(world.editor, world.workspaceId);
    const viewer = await signIn(world.viewer, world.workspaceId, { scopes: ['read'] });
    assert.equal((await toolsList('/api/mcp', editor.access)).status, 200);

    const removed = await request(
      'DELETE',
      `/api/private/workspaces/${world.workspaceId}/members/${world.editor.id}`,
      { token: world.owner.token },
    );
    assert.ok(removed.status === 200 || removed.status === 204, removed.text);

    assert.equal((await toolsList('/api/mcp', editor.access)).status, 401);
    const refresh = await request('POST', '/api/mcp/oauth/token', {
      form: {
        grant_type: 'refresh_token',
        refresh_token: editor.refresh,
        client_id: editor.clientId,
      },
    });
    assert.equal(refresh.status, 400);
    assert.equal(refresh.body?.['error'], 'invalid_grant');
    assert.equal((await toolsList('/api/mcp', viewer.access)).status, 200);
  });

  it('revoke endpoint ends a grant; an unknown token still answers 200', async () => {
    const world = await newWorld('revoke');
    const grant = await signIn(world.editor, world.workspaceId);
    const res = await request('POST', '/api/mcp/oauth/revoke', {
      form: { token: grant.refresh, client_id: grant.clientId },
    });
    assert.equal(res.status, 200, res.text);
    assert.equal((await toolsList('/api/mcp', grant.access)).status, 401);

    const unknown = await request('POST', '/api/mcp/oauth/revoke', {
      form: { token: `elr_${'z'.repeat(43)}`, client_id: grant.clientId },
    });
    assert.equal(unknown.status, 200);
  });

  it('token responses carry no-store and never pass through the {data} envelope', async () => {
    const world = await newWorld('envelope');
    const clientId = await registerClient();
    const verifier = newVerifier();
    const id = await authorize(clientId, verifier);
    const redirect = await approve(id, world.editor, world.workspaceId);
    const res = await exchange(clientId, redirect.searchParams.get('code') ?? '', verifier);
    assert.equal(res.status, 200, res.text);
    assert.equal(res.headers.get('cache-control'), 'no-store');
    assert.ok(res.body !== null && !('data' in res.body));
    assert.deepEqual(Object.keys(res.body).sort(), [
      'access_token',
      'expires_in',
      'refresh_token',
      'scope',
      'token_type',
    ]);
    const failed = await exchange(clientId, 'elc_bad', verifier);
    assert.equal(failed.status, 400);
    assert.equal(failed.headers.get('cache-control'), 'no-store');
    assert.deepEqual(Object.keys(failed.body ?? {}).sort(), ['error', 'error_description']);
  });
});

describe('rate limits', () => {
  it('register is rate limited', async () => {
    let limited = 0;
    for (let attempt = 0; attempt < 40; attempt += 1) {
      const res = await request('POST', '/api/mcp/oauth/register', {
        json: { client_name: 'Spam', redirect_uris: [REDIRECT] },
      });
      if (res.status === 429) limited += 1;
    }
    assert.ok(limited > 0, 'expected a 429 within 40 registrations');
  });

  it('token and revoke are not limited by register traffic', async () => {
    let limited = false;
    for (let attempt = 0; attempt < 60 && !limited; attempt += 1) {
      const res = await request('POST', '/api/mcp/oauth/register', {
        json: { client_name: 'Spam', redirect_uris: [REDIRECT] },
      });
      limited = res.status === 429;
    }
    assert.ok(limited, 'register must be at its limit before token and revoke are checked');
    const token = await request('POST', '/api/mcp/oauth/token', {
      form: { grant_type: 'password', client_id: 'x' },
    });
    assert.equal(token.status, 400);
    assert.equal(token.body?.['error'], 'unsupported_grant_type');
    const revoke = await request('POST', '/api/mcp/oauth/revoke', {
      form: { token: 'unknown', client_id: 'x' },
    });
    assert.equal(revoke.status, 200);
  });
});
