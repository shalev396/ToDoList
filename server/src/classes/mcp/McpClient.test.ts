/** McpClient: registration rules, redirect matching, and CIMD resolution (SSRF-guarded). */
import { after, afterEach, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { OAuthErrorCode } from '../../errors/OAuthError.js';
import { OAuthError } from '../../errors/OAuthError.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { McpClient as McpClientClass } from './McpClient.js';

let db: TestDatabase;
let McpClient: typeof McpClientClass;

before(async () => {
  db = await startTestDatabase('todolist_mcp_client_test');
  ({ McpClient } = await import('./McpClient.js'));
});

after(async () => {
  McpClient.setMetadataFetchForTests(null);
  await db.stop();
});

afterEach(() => {
  McpClient.setMetadataFetchForTests(null);
});

async function refusal(promise: Promise<unknown>): Promise<OAuthErrorCode> {
  try {
    await promise;
  } catch (error) {
    assert.ok(error instanceof OAuthError);
    return error.oauthCode;
  }
  return assert.fail('expected an OAuthError');
}

describe('McpClient.register', () => {
  it('registers a public client with https and loopback redirects', async () => {
    const client = await McpClient.register(
      {
        client_name: 'Claude',
        redirect_uris: ['https://claude.example/cb', 'http://localhost:7000/cb', 'http://[::1]/cb'],
        token_endpoint_auth_method: 'none',
        grant_types: ['authorization_code', 'refresh_token'],
        response_types: ['code'],
      },
      {},
    );
    assert.equal(client.name, 'Claude');
    assert.equal(client.redirectUris.length, 3);
    const again = await McpClient.resolve(client.id);
    assert.equal(again.name, 'Claude');
    assert.ok(again.allowsRedirect('https://claude.example/cb'));
  });

  it('refuses http on a public host, a fragment, a custom scheme and a missing client_name', async () => {
    const ok = 'https://app.example/cb';
    const bad = async (uri: string): Promise<OAuthErrorCode> =>
      refusal(McpClient.register({ client_name: 'X', redirect_uris: [uri] }, {}));
    assert.equal(await bad('http://app.example/cb'), 'invalid_redirect_uri');
    assert.equal(await bad('https://app.example/cb#frag'), 'invalid_redirect_uri');
    assert.equal(await bad('https://app.example/cb#'), 'invalid_redirect_uri');
    assert.equal(await bad('cursor://callback'), 'invalid_redirect_uri');
    assert.equal(await bad('javascript:alert(1)'), 'invalid_redirect_uri');
    assert.equal(await bad('https://u:p@app.example/cb'), 'invalid_redirect_uri');
    assert.equal(await bad('http://127.0.0.1.evil.example/cb'), 'invalid_redirect_uri');
    assert.equal(await bad('not a url'), 'invalid_redirect_uri');
    assert.equal(
      await refusal(McpClient.register({ redirect_uris: [ok] }, {})),
      'invalid_client_metadata',
    );
    assert.equal(
      await refusal(McpClient.register({ client_name: '', redirect_uris: [ok] }, {})),
      'invalid_client_metadata',
    );
    assert.equal(
      await refusal(McpClient.register({ client_name: 'x'.repeat(101), redirect_uris: [ok] }, {})),
      'invalid_client_metadata',
    );
    assert.equal(await refusal(McpClient.register('nope', {})), 'invalid_client_metadata');
    assert.equal(
      await refusal(McpClient.register({ client_name: 'X', redirect_uris: [] }, {})),
      'invalid_redirect_uri',
    );
    assert.equal(
      await refusal(
        McpClient.register(
          {
            client_name: 'X',
            redirect_uris: Array.from({ length: 11 }, (_, i) => `https://a.example/${String(i)}`),
          },
          {},
        ),
      ),
      'invalid_redirect_uri',
    );
  });

  it('refuses a confidential client, other grant types and other response types', async () => {
    const base = { client_name: 'X', redirect_uris: ['https://app.example/cb'] };
    for (const extra of [
      { token_endpoint_auth_method: 'client_secret_basic' },
      { grant_types: ['client_credentials'] },
      { grant_types: ['authorization_code', 'password'] },
      { response_types: ['token'] },
    ]) {
      assert.equal(
        await refusal(McpClient.register({ ...base, ...extra }, {})),
        'invalid_client_metadata',
      );
    }
  });
});

describe('McpClient.allowsRedirect', () => {
  it('allowsRedirect: loopback port may differ; path, trailing slash and https port may not', async () => {
    const c = await McpClient.register(
      { client_name: 'X', redirect_uris: ['http://127.0.0.1:5000/cb', 'https://app.example/cb'] },
      {},
    );
    assert.equal(c.allowsRedirect('http://127.0.0.1:61234/cb'), true);
    assert.equal(c.allowsRedirect('http://127.0.0.1/cb'), true);
    assert.equal(c.allowsRedirect('http://127.0.0.1:61234/cb/'), false);
    assert.equal(c.allowsRedirect('http://127.0.0.1:61234/other'), false);
    assert.equal(c.allowsRedirect('http://localhost:61234/cb'), false);
    assert.equal(c.allowsRedirect('https://127.0.0.1:61234/cb'), false);
    assert.equal(c.allowsRedirect('http://127.0.0.1:61234/cb?x=1'), false);
    assert.equal(c.allowsRedirect('http://127.0.0.1:61234/cb#f'), false);
    assert.equal(c.allowsRedirect('https://app.example/cb'), true);
    assert.equal(c.allowsRedirect('https://app.example/cb/'), false);
    assert.equal(c.allowsRedirect('https://app.example:8443/cb'), false);
    assert.equal(c.allowsRedirect('https://evil.example/cb'), false);
    assert.equal(c.allowsRedirect('https://app.example/cb#f'), false);
    assert.equal(c.allowsRedirect('http://app.example/cb'), false);
  });
});

describe('McpClient.resolve', () => {
  const url = 'https://client.example/oauth/client.json';

  it('resolves a CIMD client whose document names itself', async () => {
    let calls = 0;
    McpClient.setMetadataFetchForTests(() => {
      calls += 1;
      return Promise.resolve({
        client_id: url,
        client_name: 'Hosted',
        redirect_uris: ['http://127.0.0.1/cb', 'https://client.example/cb'],
      });
    });
    const client = await McpClient.resolve(url);
    assert.equal(client.id, url);
    assert.equal(client.name, 'Hosted');
    assert.equal(client.allowsRedirect('http://127.0.0.1:9999/cb'), true);
    await McpClient.resolve(url);
    assert.equal(calls, 1, 'the second resolve is served from the cache');
  });

  it('refuses a CIMD document whose client_id differs', async () => {
    McpClient.setMetadataFetchForTests(() =>
      Promise.resolve({
        client_id: 'https://other.example/x',
        client_name: 'Liar',
        redirect_uris: ['https://client.example/cb'],
      }),
    );
    assert.equal(await refusal(McpClient.resolve('https://liar.example/c.json')), 'invalid_client');
  });

  it('refuses a CIMD document with bad redirects or no name, and a failing fetch', async () => {
    const u = 'https://bad.example/c.json';
    McpClient.setMetadataFetchForTests(() =>
      Promise.resolve({ client_id: u, client_name: 'X', redirect_uris: ['http://bad.example/cb'] }),
    );
    assert.equal(await refusal(McpClient.resolve(u)), 'invalid_client');
    McpClient.setMetadataFetchForTests(() =>
      Promise.resolve({ client_id: u, redirect_uris: ['https://bad.example/cb'] }),
    );
    assert.equal(await refusal(McpClient.resolve(u)), 'invalid_client');
    McpClient.setMetadataFetchForTests(() => Promise.reject(new Error('boom')));
    assert.equal(await refusal(McpClient.resolve(u)), 'invalid_client');
  });

  it('refuses a CIMD URL on a private address without fetching', async () => {
    let calls = 0;
    McpClient.setMetadataFetchForTests(() => {
      calls += 1;
      return Promise.resolve({});
    });
    for (const id of ['https://10.0.0.1/c', 'https://localhost/c', 'https://169.254.169.254/c']) {
      assert.equal(await refusal(McpClient.resolve(id)), 'invalid_client');
    }
    assert.equal(calls, 0);
  });

  it('an unknown client_id is invalid_client', async () => {
    assert.equal(await refusal(McpClient.resolve('nope')), 'invalid_client');
    assert.equal(
      await refusal(McpClient.resolve('00000000-0000-4000-8000-000000000000')),
      'invalid_client',
    );
    assert.equal(await refusal(McpClient.resolve('https://client.example/')), 'invalid_client');
  });
});
