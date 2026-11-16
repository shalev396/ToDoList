/**
 * Rate limits (MCP.md §3): over the per-agent cap the answer is a JSON-RPC error (429), counted
 * once per request per presented key across /api/mcp and /api/mcp/readonly, before the key is
 * looked up, without touching other keys; failed authentications are limited per address (an IPv6
 * address by its /56), and only failed lookups of a well-formed key are counted: a key that
 * authenticates never spends the budget and is never held off by it, even from an address over it
 * (hosted assistants share addresses), and a request with no well-formed key gets the 401
 * challenge without spending it. The router runs at /api/mcp and /spare/api/mcp with tiny caps
 * (each its own budgets), and at /default/api/mcp with the real ones.
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request } from 'express';

import { addressKey } from '../../utils/clientAddress.js';
import type * as Limiter from '../middleware/limiter.js';
import type { TestKey } from './helpers/agentKeys.js';
import { insertAgentKey, newRawKey } from './helpers/agentKeys.js';
import { MCP_HEADERS, startMcpHarness, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

let h: McpHarness;
let team: Team;
let limiter: typeof Limiter;

const AGENT_CAP = 4;
const AUTH_FAILURE_CAP = 2;

const INITIALIZE = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: {
    protocolVersion: '2025-06-18',
    capabilities: {},
    clientInfo: { name: 'limiter-test', version: '1.0.0' },
  },
};

before(async () => {
  h = await startMcpHarness('todolist_mcp_limiter_test', {
    rateLimits: true,
    app: async () => {
      const express = (await import('express')).default;
      const { createMcpRouter } = await import('../index.js');
      const app = express();
      app.use(
        '/api/mcp',
        express.json(),
        createMcpRouter({
          agentLimit: { max: AGENT_CAP, windowMs: 60_000 },
          authFailureLimit: { max: AUTH_FAILURE_CAP, windowMs: 60_000 },
        }),
      );
      app.use(
        '/spare/api/mcp',
        express.json(),
        createMcpRouter({
          agentLimit: { max: AGENT_CAP, windowMs: 60_000 },
          authFailureLimit: { max: AUTH_FAILURE_CAP, windowMs: 60_000 },
        }),
      );
      app.use('/default/api/mcp', express.json(), createMcpRouter());
      return app;
    },
  });
  team = await newTeam('limiter');
  limiter = await import('../middleware/limiter.js');
});

after(async () => {
  await h.stop();
});

async function key(): Promise<TestKey> {
  return insertAgentKey({
    workspaceId: team.workspace.id,
    userId: team.owner.id,
    scopes: ['workspace:read'],
  });
}

function post(path: string, raw: string): ReturnType<McpHarness['post']> {
  return h.post(path, INITIALIZE, { ...MCP_HEADERS, authorization: `Bearer ${raw}` });
}

/** A POST with this Authorization header, or none. */
function postWith(path: string, authorization?: string): ReturnType<McpHarness['post']> {
  return h.post(
    path,
    INITIALIZE,
    authorization === undefined ? MCP_HEADERS : { ...MCP_HEADERS, authorization },
  );
}

const CHALLENGE = /^Bearer realm="todolist-mcp", resource_metadata="[^"]+", scope="[^"]+"/;

describe('the per-agent limit', () => {
  it('answers past the cap with a JSON-RPC error and a 429, counting each request once', async () => {
    const agent = await key();
    for (let i = 0; i < AGENT_CAP; i += 1) {
      const response = await post('/api/mcp', agent.raw);
      assert.equal(response.status, 200);
      assert.equal(response.headers.get('ratelimit-limit'), String(AGENT_CAP));
      assert.equal(response.headers.get('ratelimit-remaining'), String(AGENT_CAP - 1 - i));
    }
    const limited = await post('/api/mcp', agent.raw);
    assert.equal(limited.status, 429);
    assert.match(limited.headers.get('content-type') ?? '', /^application\/json/);
    assert.notEqual(limited.headers.get('retry-after'), null);
    assert.deepEqual(JSON.parse(limited.text), {
      jsonrpc: '2.0',
      id: 1,
      error: {
        code: -32002,
        message: 'Too many requests for this agent key. Wait a minute and try again.',
      },
    });
  });

  it('counts one budget across /api/mcp and /api/mcp/readonly', async () => {
    const agent = await key();
    for (let i = 0; i < AGENT_CAP; i += 1) {
      const path = i % 2 === 0 ? '/api/mcp' : '/api/mcp/readonly';
      assert.equal((await post(path, agent.raw)).status, 200);
    }
    assert.equal((await post('/api/mcp/readonly', agent.raw)).status, 429);
  });

  it('leaves other agent keys alone', async () => {
    const busy = await key();
    const quiet = await key();
    for (let i = 0; i <= AGENT_CAP; i += 1) await post('/api/mcp', busy.raw);
    assert.equal((await post('/api/mcp', busy.raw)).status, 429);
    assert.equal((await post('/api/mcp', quiet.raw)).status, 200);
  });

  it('reaches the SDK client as an error it can read', async () => {
    const agent = await key();
    // initialize + notifications/initialized + tools/list + tools/call = the cap of 4.
    const client = await h.connect(agent.raw);
    await client.listTools();
    await client.callTool({ name: 'workspace_get', arguments: {} });
    await assert.rejects(
      client.callTool({ name: 'workspace_get', arguments: {} }),
      /Too many requests for this agent key/,
    );
  });
});

describe('the failed-authentication limit', () => {
  it('counts failures only: a key that authenticates never spends the budget', async () => {
    const agent = await key();
    const spends = mock.method(limiter.AuthFailureLimit.prototype, 'spend');
    try {
      for (let i = 0; i < AUTH_FAILURE_CAP; i += 1) {
        assert.equal(
          (await post('/spare/api/mcp', agent.raw)).status,
          200,
          `good key ${String(i)}`,
        );
      }
      assert.equal(spends.mock.callCount(), 0, 'a good key spends nothing');
      for (let i = 0; i < AUTH_FAILURE_CAP; i += 1) {
        assert.equal(
          (await post('/spare/api/mcp', newRawKey())).status,
          401,
          `bad key ${String(i)}`,
        );
        assert.equal(
          (await post('/spare/api/mcp', agent.raw)).status,
          200,
          `then good ${String(i)}`,
        );
      }
      assert.equal(spends.mock.callCount(), AUTH_FAILURE_CAP, 'one spend per failure, no more');
      // The budget holds exactly the failures: the next one is over it.
      assert.equal((await post('/spare/api/mcp', newRawKey())).status, 429);
      assert.equal(spends.mock.callCount(), AUTH_FAILURE_CAP + 1);
    } finally {
      spends.mock.restore();
    }
  });

  it('without a well-formed key: the 401 challenge, no lookup and no spend', async () => {
    const { AgentKey } = await import('../../classes/AgentKey.js');
    const spends = mock.method(limiter.AuthFailureLimit.prototype, 'spend');
    const lookups = mock.method(AgentKey, 'authenticate');
    try {
      for (const authorization of [undefined, 'Bearer nope', 'Basic test', 'elk_x']) {
        for (let i = 0; i <= AUTH_FAILURE_CAP; i += 1) {
          const response = await postWith('/spare/api/mcp/readonly', authorization);
          assert.equal(response.status, 401, String(authorization));
          assert.match(response.headers.get('www-authenticate') ?? '', CHALLENGE);
          assert.equal(response.headers.get('ratelimit-limit'), null, 'no limiter counted it');
        }
      }
      assert.equal(spends.mock.callCount(), 0);
      assert.equal(lookups.mock.callCount(), 0);
    } finally {
      spends.mock.restore();
      lookups.mock.restore();
    }
  });

  it('over the budget: a failed key gets 429, a valid key from the same address still gets in', async () => {
    for (let i = 0; i < AUTH_FAILURE_CAP; i += 1) {
      assert.equal((await post('/api/mcp', newRawKey())).status, 401);
    }
    const limited = await post('/api/mcp', newRawKey());
    assert.equal(limited.status, 429);
    assert.notEqual(limited.headers.get('retry-after'), null);
    // Still the challenge, so a client whose token expired can refresh or sign in after waiting.
    assert.match(limited.headers.get('www-authenticate') ?? '', CHALLENGE);
    assert.match(limited.headers.get('www-authenticate') ?? '', /error="invalid_token"/);
    // No well-formed key: the plain 401 challenge, never the 429.
    const anonymous = await postWith('/api/mcp');
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('www-authenticate') ?? '', CHALLENGE);
    assert.equal((await postWith('/api/mcp', 'Bearer not-a-key')).status, 401);
    assert.equal(
      (JSON.parse(limited.text) as { error: { message: string } }).error.message,
      'Too many failed authentications from this address. Try again later.',
    );
    const good = await key();
    assert.equal((await post('/api/mcp', good.raw)).status, 200);
    assert.equal((await post('/api/mcp/readonly', good.raw)).status, 200);
    // Still over it for the next failure: the valid key neither spent nor reset the budget.
    assert.equal((await post('/api/mcp', newRawKey())).status, 429);
  });

  it('with the real cap: 50 bad keys, then a valid key from the same address still gets in', async () => {
    for (let i = 0; i < 50; i += 1) {
      assert.equal(
        (await post('/default/api/mcp', newRawKey())).status,
        401,
        `bad key ${String(i)}`,
      );
    }
    assert.equal((await post('/default/api/mcp', newRawKey())).status, 429);
    assert.equal((await post('/default/api/mcp', (await key()).raw)).status, 200);
    assert.equal((await post('/default/api/mcp', newRawKey())).status, 429);
  });
});

describe('the per-agent key', () => {
  const request = (authorization?: string): Request =>
    ({ ip: '203.0.113.7', headers: { authorization } }) as Request;

  it('is the presented key, by its SHA-256, never the key itself', () => {
    const raw = newRawKey();
    const counted = limiter.agentKey(request(`Bearer ${raw}`));
    assert.match(counted, /^key:[0-9a-f]{64}$/);
    assert.ok(!counted.includes(raw.slice(4)));
    assert.equal(limiter.agentKey(request(`bearer  ${raw}`)), counted);
    assert.notEqual(limiter.agentKey(request(`Bearer ${newRawKey()}`)), counted);
  });

  it('is the address when no well-formed key is presented', () => {
    assert.equal(limiter.agentKey(request()), 'ip:203.0.113.7');
    assert.equal(limiter.agentKey(request('Bearer nope')), 'ip:203.0.113.7');
  });
});

describe('the address a failed authentication counts against', () => {
  it('is an IPv4 address as it is', () => {
    assert.equal(addressKey('203.0.113.7'), '203.0.113.7');
  });

  it('is an IPv4-mapped IPv6 address as its IPv4 address', () => {
    assert.equal(addressKey('::ffff:203.0.113.7'), '203.0.113.7');
  });

  it('is an IPv6 address masked to its /56', () => {
    const key = addressKey('2001:db8:abcd:12ff:1:2:3:4');
    assert.equal(key, '2001:db8:abcd:1200::/56');
    for (const sibling of ['2001:db8:abcd:1234::1', '2001:0db8:abcd:12aa:ffff::9%eth0']) {
      assert.equal(addressKey(sibling), key, sibling);
    }
    assert.notEqual(addressKey('2001:db8:abcd:1300::1'), key);
    assert.equal(addressKey('::1'), '0:0:0:0::/56');
  });

  it('is a fixed key when the address is unknown', () => {
    assert.equal(addressKey(undefined), 'unknown');
  });
});
