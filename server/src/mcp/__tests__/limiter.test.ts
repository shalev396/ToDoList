/**
 * Rate limits (MCP.md §3): over the per-agent cap the answer is a JSON-RPC error (429), counted
 * per agent key across /api/mcp and /api/mcp/readonly, without touching other keys; failed
 * authentications are limited per address (an IPv6 address by its /56), and only failed ones are
 * counted: keys that authenticate never use the budget up. An address that has used it up gets
 * 429 for every key, a good one too, before any key is looked up. The router runs at /api/mcp
 * and /spare/api/mcp with tiny caps (each its own budgets), and at /default/api/mcp with the real
 * ones.
 */
import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';
import type { Request, Response } from 'express';

import type { AgentKey as AgentKeyClass } from '../../classes/AgentKey.js';
import type * as Principal from '../auth/principal.js';
import type * as Limiter from '../middleware/limiter.js';
import type { TestKey } from './helpers/agentKeys.js';
import { insertAgentKey, newRawKey } from './helpers/agentKeys.js';
import { MCP_HEADERS, startMcpHarness, type McpHarness } from './helpers/mcpHarness.js';
import { newTeam, type Team } from './helpers/team.js';

let h: McpHarness;
let team: Team;
let limiter: typeof Limiter;
let principal: typeof Principal;
let AgentKey: typeof AgentKeyClass;

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
  principal = await import('../auth/principal.js');
  ({ AgentKey } = await import('../../classes/AgentKey.js'));
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

describe('the per-agent limit', () => {
  it('answers past the cap with a JSON-RPC error and a 429', async () => {
    const agent = await key();
    for (let i = 0; i < AGENT_CAP; i += 1)
      assert.equal((await post('/api/mcp', agent.raw)).status, 200);
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
  it('counts failures only: keys that authenticate never use the budget up', async () => {
    const agent = await key();
    for (let i = 0; i < AUTH_FAILURE_CAP + 2; i += 1) {
      assert.equal((await post('/spare/api/mcp', agent.raw)).status, 200, `good key ${String(i)}`);
    }
    for (let i = 0; i < AUTH_FAILURE_CAP; i += 1) {
      assert.equal((await post('/spare/api/mcp', newRawKey())).status, 401, `bad key ${String(i)}`);
    }
    assert.equal((await post('/spare/api/mcp', newRawKey())).status, 429);
  });

  it('holds off every key from an address over its budget, without looking one up', async () => {
    for (let i = 0; i < AUTH_FAILURE_CAP; i += 1) {
      assert.equal((await post('/api/mcp', newRawKey())).status, 401);
    }
    const good = await key();
    const lookups = mock.method(AgentKey, 'authenticate');
    try {
      const limited = await post('/api/mcp', newRawKey());
      assert.equal(limited.status, 429);
      assert.notEqual(limited.headers.get('retry-after'), null);
      assert.equal(
        (JSON.parse(limited.text) as { error: { message: string } }).error.message,
        'Too many failed authentications from this address. Try again later.',
      );
      assert.equal((await post('/api/mcp', good.raw)).status, 429);
      assert.equal((await post('/api/mcp/readonly', good.raw)).status, 429);
      assert.equal(lookups.mock.callCount(), 0);
    } finally {
      lookups.mock.restore();
    }
  });

  it('with the real cap: 50 bad keys, then the address waits, even with a valid key', async () => {
    for (let i = 0; i < 50; i += 1) {
      assert.equal(
        (await post('/default/api/mcp', newRawKey())).status,
        401,
        `bad key ${String(i)}`,
      );
    }
    assert.equal((await post('/default/api/mcp', newRawKey())).status, 429);
    assert.equal((await post('/default/api/mcp', (await key()).raw)).status, 429);
  });
});

describe('the per-agent key', () => {
  const request = { ip: '203.0.113.7' } as Request;

  it('is the authenticated agent key', () => {
    const res = { locals: {} } as unknown as Response;
    principal.setRequestAgent(res, {
      principal: { agentId: 'key-1' },
    } as Principal.AuthenticatedAgent);
    assert.equal(limiter.agentKey(request, res), 'agent:key-1');
  });

  it('is the address when no agent was authenticated', () => {
    const res = { locals: {} } as unknown as Response;
    assert.equal(limiter.agentKey(request, res), 'ip:203.0.113.7');
  });
});

describe('the address a failed authentication counts against', () => {
  it('is an IPv4 address as it is', () => {
    assert.equal(limiter.addressKey('203.0.113.7'), '203.0.113.7');
  });

  it('is an IPv4-mapped IPv6 address as its IPv4 address', () => {
    assert.equal(limiter.addressKey('::ffff:203.0.113.7'), '203.0.113.7');
  });

  it('is an IPv6 address masked to its /56', () => {
    const key = limiter.addressKey('2001:db8:abcd:12ff:1:2:3:4');
    assert.equal(key, '2001:db8:abcd:1200::/56');
    for (const sibling of ['2001:db8:abcd:1234::1', '2001:0db8:abcd:12aa:ffff::9%eth0']) {
      assert.equal(limiter.addressKey(sibling), key, sibling);
    }
    assert.notEqual(limiter.addressKey('2001:db8:abcd:1300::1'), key);
    assert.equal(limiter.addressKey('::1'), '0:0:0:0::/56');
  });

  it('is a fixed key when the address is unknown', () => {
    assert.equal(limiter.addressKey(undefined), 'unknown');
  });
});
