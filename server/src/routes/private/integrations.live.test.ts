/**
 * "Test connection" in live mode (no forced fixtures): the secret is decrypted only inside
 * CredentialVault.decryptForSync, the adapter gets it there, and nothing of it, nor of the
 * provider's own text, comes back or is logged. One try per request and 10 s for the whole test.
 *
 * The test adapters behave like real ones (their own client, with its default retries, over the
 * transport and clock they are handed); under the connection test's guards, an in-memory stub
 * provider stands in for the live network (setLiveTransportForTests). Nothing leaves the machine
 * (outbound guard).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type * as Models from '../../models/index.js';
import {
  createReadOnlyClient,
  type HttpRequest,
  type ReadOnlyClient,
  type Transport,
} from '../../sync/http.js';
import { getAdapter, registerAdapter, unregisterAdapter } from '../../sync/registry.js';
import type {
  AdapterPage,
  ConnectionTestResult,
  ProviderAdapter,
  ResourceResult,
} from '../../sync/types.js';
import { startApiHarness, type ApiHarness, type ApiResponse } from '../../testing/apiHarness.js';
import { createFakeAdapter } from '../../testing/fakeAdapter.js';
import { installOutboundGuard, type OutboundGuard } from '../../testing/outboundGuard.js';
import type { Provider } from '../../types/domain.js';

const LINEAR = { apiKey: 'lin_api_FAKE0123456789abcdefghij' };
const JIRA = { email: 'jira-live@example.test', token: 'ATATT3xFAKE0123456789abcdefghij' };
const PROVIDER_TEXT = 'Invalid key for workspace ACME-PRIVATE-0042';

let api: ApiHarness;
let guard: OutboundGuard;
let models: typeof Models;
let token: string;
let ownerId: string;
let workspaces = 0;

interface Reply {
  status: number;
  body: unknown;
  headers?: Record<string, string>;
}

/** What the stub provider does next: answer, fail like a network, or never answer. */
let reply: Reply | 'network' | 'hang' = { status: 200, body: { name: 'Live Account' } };
/** When set, the adapter throws an error quoting the secret instead of calling the provider. */
let throwQuotingSecret = false;
/** When set, the adapter's test sends its one request twice, exactly alike. */
let sameRequestTwice = false;
/** The retries the adapter asks its own client for (unset: the client's default). */
let askedRetries: number | undefined;
/** The retry cap of each transport an adapter's createClient was handed. */
const handedCaps: (number | undefined)[] = [];
/** Requests that reached the provider, and the request timeout each live transport was made with. */
const requests: HttpRequest[] = [];
const transportTimeouts: number[] = [];
const originals = new Map<Provider, ProviderAdapter | null>();

const stubProvider: Transport = {
  send(request) {
    requests.push(request);
    if (reply === 'network') return Promise.reject(new Error('connect ECONNREFUSED'));
    if (reply === 'hang') return new Promise(() => undefined);
    return Promise.resolve({
      status: reply.status,
      headers: reply.headers ?? {},
      body: JSON.stringify(reply.body),
    });
  },
};

/** A resource with nothing in it: a live sync of the test adapters never calls the network. */
async function* nothingToFetch(): AsyncGenerator<AdapterPage, ResourceResult> {
  const pages: AdapterPage[] = await Promise.resolve([]);
  yield* pages;
  return { nextState: {}, fullSync: true };
}

/**
 * Like a real adapter: its own client, with the default retries, over the transport and clock it
 * is handed. The connection test reads `name` from GET /me; a sync lists nothing (no network).
 */
function liveAdapter(provider: Provider): ProviderAdapter {
  return {
    ...createFakeAdapter().adapter,
    provider,
    createClient: (transport, clock): ReadOnlyClient => {
      handedCaps.push(transport.maxRetries);
      return createReadOnlyClient({
        provider,
        transport,
        ...(clock === undefined ? {} : { clock }),
        ...(askedRetries === undefined ? {} : { maxRetries: askedRetries }),
      });
    },
    resources: () => ['nothing'],
    fetch: () => nothingToFetch(),
    async test(ctx): Promise<ConnectionTestResult> {
      // The integration's strategy builds the header from the saved credential.
      const headers = await ctx.auth.headers();
      if (throwQuotingSecret) throw new Error(`adapter bug: ${headers['authorization'] ?? ''}`);
      const me = (): Promise<{ data: { name: string } }> =>
        ctx.client.getJson<{ name: string }>('https://provider.example.invalid/me', headers);
      if (sameRequestTwice) await me();
      const { data } = await me();
      return { accountLabel: data.name, capabilities: { issues: true } };
    },
  };
}

function useAdapter(adapter: ProviderAdapter): void {
  originals.set(adapter.provider, getAdapter(adapter.provider));
  unregisterAdapter(adapter.provider);
  registerAdapter(adapter);
}

before(async () => {
  api = await startApiHarness('todolist_integrations_live');
  guard = installOutboundGuard();
  models = await import('../../models/index.js');
  token = (await api.login('live-owner@example.test')).token;
  const me = await api.call('GET', '/api/private/me', { token });
  ownerId = (me.body?.['data'] as { id: string }).id;
  useAdapter(liveAdapter('linear'));
  useAdapter(liveAdapter('jira'));
  const { setLiveTransportForTests } = await import('../../classes/integration/connectionTest.js');
  setLiveTransportForTests((timeoutMs) => {
    transportTimeouts.push(timeoutMs);
    return stubProvider;
  });
});

after(async () => {
  // The harness always stops, even when setup failed: a running mongod keeps the process alive.
  try {
    const { setLiveTransportForTests } =
      await import('../../classes/integration/connectionTest.js');
    setLiveTransportForTests(null);
    for (const [provider, adapter] of originals) {
      unregisterAdapter(provider);
      if (adapter !== null) registerAdapter(adapter);
    }
  } finally {
    guard.restore();
    await api.stop();
  }
});

async function newWorkspace(): Promise<string> {
  workspaces += 1;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Live', slug: `live-${String(workspaces)}`, ownerId });
  await (
    await models.getMembershipRepository()
  ).create(workspace.id, {
    userId: ownerId,
    role: 'owner',
  });
  return workspace.id;
}

const path = (wid: string, rest = ''): string =>
  `/api/private/workspaces/${wid}/integrations${rest}`;

async function call(method: string, url: string, body?: unknown): Promise<ApiResponse> {
  return api.call(method, url, { token, ...(body === undefined ? {} : { body }) });
}

async function connected(
  wid: string,
  body: Record<string, unknown>,
  secret: Record<string, string> | null,
): Promise<string> {
  const res = await call('POST', path(wid), body);
  assert.equal(res.status, 201, res.text);
  const { id } = res.body?.['data'] as { id: string };
  if (secret !== null) {
    assert.equal((await call('PUT', path(wid, `/${id}/credential`), secret)).status, 204);
  }
  return id;
}

async function logsDuring(fn: () => Promise<void>): Promise<string> {
  const original = process.stderr.write.bind(process.stderr);
  let captured = '';
  process.stderr.write = (chunk: string | Uint8Array): boolean => {
    captured += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    return true;
  };
  try {
    await fn();
  } finally {
    process.stderr.write = original;
  }
  return captured;
}

/** POST …/test with the stub set up; the answer's data, its raw text and the logs. */
async function testConnection(
  wid: string,
  id: string,
): Promise<{ data: unknown; text: string; logs: string }> {
  let data: unknown = null;
  let text = '';
  const logs = await logsDuring(async () => {
    const res = await call('POST', path(wid, `/${id}/test`));
    assert.equal(res.status, 200, res.text);
    data = res.body?.['data'];
    text = res.text;
  });
  return { data, text, logs };
}

function assertClean(where: string, text: string, ...values: string[]): void {
  for (const value of [LINEAR.apiKey, JIRA.token, ...values]) {
    assert.ok(!text.includes(value), `${where} holds a secret or provider text`);
  }
}

async function integration(wid: string, id: string): Promise<Models.IntegrationData | null> {
  return (await models.getIntegrationRepository()).findById(wid, id);
}

const LINEAR_BODY = { provider: 'linear', config: {} };

describe('POST …/integrations/:iid/test in live mode', () => {
  it('decrypts only inside the vault: the adapter gets the saved key, the use is recorded, nothing secret comes back', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    reply = { status: 200, body: { name: 'Live Account' } };
    requests.length = 0;
    transportTimeouts.length = 0;
    const { data, text, logs } = await testConnection(wid, id);
    assert.deepEqual(data, {
      ok: true,
      accountLabel: 'Live Account',
      capabilities: { issues: true },
    });
    assert.equal(requests.length, 1);
    const [request] = requests;
    assert.ok(request);
    assert.equal(request.method, 'GET');
    // Linear's personal API key goes as is (its strategy's header).
    assert.ok(request.headers['authorization'] === LINEAR.apiKey, 'the saved key');
    assert.deepEqual(transportTimeouts, [10_000], 'one live transport, 10 s per request');
    const credential = await (await models.getCredentialRepository()).findMeta(wid, id);
    assert.ok(credential?.lastUsedAt instanceof Date, 'the vault recorded the use');
    assertClean('the answer', text);
    assertClean('the logs', logs);
    const stored = await integration(wid, id);
    assert.deepEqual([stored?.accountId, stored?.label], ['Live Account', 'Live Account']);
  });

  it('Jira may answer with the account email: an identity field of the credential, not a secret', async () => {
    const wid = await newWorkspace();
    const id = await connected(
      wid,
      { provider: 'jira', config: { baseUrl: 'https://autods.atlassian.net' } },
      JIRA,
    );
    reply = { status: 200, body: { name: JIRA.email } };
    const { data, logs } = await testConnection(wid, id);
    assert.deepEqual(data, { ok: true, accountLabel: JIRA.email, capabilities: { issues: true } });
    assertClean('the logs', logs);
    const stored = await integration(wid, id);
    assert.deepEqual(
      [stored?.accountId, stored?.label],
      ['autods.atlassian.net', `${JIRA.email} (autods.atlassian.net)`],
    );
  });

  it('no saved credential → credential_missing; nothing is decrypted or called', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, null);
    requests.length = 0;
    const { data } = await testConnection(wid, id);
    assert.deepEqual(data, { ok: false, code: 'credential_missing' });
    assert.equal(requests.length, 0);
  });

  it('a provider 401 → auth_failed and the integration needs a reconnect; the provider’s text stays out', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    reply = { status: 401, body: { message: PROVIDER_TEXT } };
    const { data, text, logs } = await testConnection(wid, id);
    assert.deepEqual(data, { ok: false, code: 'auth_failed' });
    assertClean('the answer', text, PROVIDER_TEXT);
    assertClean('the logs', logs, PROVIDER_TEXT);
    assert.match(logs, /code: 'auth_failed'/);
    assert.match(logs, /status: 401/);
    const stored = await integration(wid, id);
    assert.deepEqual(
      [stored?.status, stored?.lastError],
      ['error', { code: 'auth_failed', message: 'Reconnect required' }],
    );
    assert.match(stored?.accountId ?? '', /^pending:/, 'the account stays pending');
  });

  it('a paused integration stays paused on auth_failed (a pause is never overwritten)', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    await (await models.getIntegrationRepository()).update(wid, id, { status: 'paused' });
    reply = { status: 403, body: {} };
    assert.deepEqual((await testConnection(wid, id)).data, { ok: false, code: 'auth_failed' });
    assert.equal((await integration(wid, id))?.status, 'paused');
  });

  it('a provider 500 → server_error; the status is left alone', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    reply = { status: 500, body: { trace: PROVIDER_TEXT } };
    const { data, text, logs } = await testConnection(wid, id);
    assert.deepEqual(data, { ok: false, code: 'server_error' });
    assertClean('the answer', text, PROVIDER_TEXT);
    assertClean('the logs', logs, PROVIDER_TEXT);
    assert.deepEqual([(await integration(wid, id))?.status], ['active']);
  });

  it('an answer that looks like a secret → bad_response; nothing is stored', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    reply = { status: 200, body: { name: 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123' } };
    assert.deepEqual((await testConnection(wid, id)).data, { ok: false, code: 'bad_response' });
    const stored = await integration(wid, id);
    assert.match(stored?.accountId ?? '', /^pending:/);
    assert.equal(stored?.label, 'linear');
  });

  it('an adapter error that quotes the secret → internal; the log names the error only', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    throwQuotingSecret = true;
    try {
      const { data, text, logs } = await testConnection(wid, id);
      assert.deepEqual(data, { ok: false, code: 'internal' });
      assertClean('the answer', text, 'adapter bug');
      assertClean('the logs', logs, 'adapter bug');
      assert.match(logs, /errorName: 'Error'/);
    } finally {
      throwQuotingSecret = false;
    }
  });

  it('a credential that can’t be decrypted → credential_unavailable; the adapter never runs', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    const { CredentialMongoModel } = await import('../../models/mongoose/Credential.js');
    // Bound to another integration: AES-GCM refuses it.
    await CredentialMongoModel.updateOne(
      { integrationId: id },
      { $set: { 'enc.aad': `${wid}|another-integration|linear` } },
    );
    requests.length = 0;
    transportTimeouts.length = 0;
    const { data, logs } = await testConnection(wid, id);
    assert.deepEqual(data, { ok: false, code: 'credential_unavailable' });
    assert.equal(transportTimeouts.length + requests.length, 0);
    assertClean('the logs', logs);
  });
});

describe('one try and 10 s per connection test (R1)', () => {
  const once: [string, Reply | 'network', string][] = [
    ['a provider 500', { status: 500, body: {} }, 'server_error'],
    ['a provider 503', { status: 503, body: {} }, 'server_error'],
    [
      'a 429 that asks to come back in 30 s',
      { status: 429, body: {}, headers: { 'retry-after': '30' } },
      'rate_limited',
    ],
    ['a network failure', 'network', 'network'],
  ];
  for (const [what, next, code] of once) {
    it(`${what} → ${code} at once, after a single request (no retries, no waits)`, async () => {
      const wid = await newWorkspace();
      const id = await connected(wid, LINEAR_BODY, LINEAR);
      reply = next;
      requests.length = 0;
      const started = Date.now();
      const { data } = await testConnection(wid, id);
      assert.deepEqual(data, { ok: false, code });
      assert.equal(requests.length, 1, 'one request reached the provider');
      assert.ok(Date.now() - started < 2000, 'no backoff or Retry-After wait');
    });
  }

  it('a provider that never answers → network once the test’s 10 s are up', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    reply = 'hang';
    requests.length = 0;
    const started = Date.now();
    try {
      const { data } = await testConnection(wid, id);
      assert.deepEqual(data, { ok: false, code: 'network' });
    } finally {
      reply = { status: 200, body: { name: 'Live Account' } };
    }
    const took = Date.now() - started;
    assert.ok(took >= 9_500 && took < 13_000, `took ${String(took)} ms`);
    assert.equal(requests.length, 1);
  });
});

describe('maxRetries 0 for the adapter’s own client (R1): nothing is replayed', () => {
  it('the transport each adapter builds its client over is capped at 0 retries', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    reply = { status: 200, body: { name: 'Live Account' } };
    handedCaps.length = 0;
    assert.deepEqual((await testConnection(wid, id)).data, {
      ok: true,
      accountLabel: 'Live Account',
      capabilities: { issues: true },
    });
    assert.deepEqual(handedCaps, [0]);
  });

  it('an adapter that asks its client for 5 retries still sends one request on a 500', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    reply = { status: 500, body: {} };
    requests.length = 0;
    askedRetries = 5;
    try {
      assert.deepEqual((await testConnection(wid, id)).data, { ok: false, code: 'server_error' });
    } finally {
      askedRetries = undefined;
      reply = { status: 200, body: { name: 'Live Account' } };
    }
    assert.equal(requests.length, 1);
  });

  it('the same request sent twice reaches the provider twice: no answer is replayed', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, LINEAR);
    reply = { status: 200, body: { name: 'Live Account' } };
    requests.length = 0;
    sameRequestTwice = true;
    try {
      assert.deepEqual((await testConnection(wid, id)).data, {
        ok: true,
        accountLabel: 'Live Account',
        capabilities: { issues: true },
      });
    } finally {
      sameRequestTwice = false;
    }
    assert.deepEqual(
      requests.map((request) => `${request.method} ${request.url}`),
      ['GET https://provider.example.invalid/me', 'GET https://provider.example.invalid/me'],
    );
  });
});

describe('POST …/integrations/:iid/sync in live mode', () => {
  it('needs a saved credential: 409 without one, 202 with it', async () => {
    const wid = await newWorkspace();
    const id = await connected(wid, LINEAR_BODY, null);
    const refused = await call('POST', path(wid, `/${id}/sync`));
    assert.equal(refused.status, 409, refused.text);
    assert.deepEqual(refused.body, { message: 'Save the credential first' });
    const { SyncRunMongoModel } = await import('../../models/mongoose/SyncRun.js');
    assert.equal(await SyncRunMongoModel.countDocuments({ integrationId: id }), 0);

    assert.equal((await call('PUT', path(wid, `/${id}/credential`), LINEAR)).status, 204);
    reply = { status: 401, body: {} };
    const logs = await logsDuring(async () => {
      const queued = await call('POST', path(wid, `/${id}/sync`));
      assert.equal(queued.status, 202, queued.text);
      // The in-process run decrypts in live mode and ends; wait for its last write.
      for (let attempt = 0; attempt < 500; attempt += 1) {
        const busy = await SyncRunMongoModel.countDocuments({
          integrationId: id,
          status: { $in: ['queued', 'running'] },
        });
        if (busy === 0) break;
        await new Promise((resolve) => setTimeout(resolve, 20));
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    });
    assertClean('the logs', logs);
  });
});

describe('the outbound guard', () => {
  it('nothing left the machine', () => {
    assert.deepEqual(guard.externalHosts(), []);
  });
});
