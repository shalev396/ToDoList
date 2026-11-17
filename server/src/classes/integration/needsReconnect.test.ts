/**
 * `needsReconnect` of the status view: true only for an OAuth connection that is read & write
 * while its stored grant lacks the provider's write scope (Jira `write:jira-work`, Linear `write`).
 * A read-only one, a key or token, demo data, a grant that has the scope and a provider without a
 * write scope (GitHub) are all false.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type * as Models from '../../models/index.js';
import type { AuthMethod, Provider } from '../../types/domain.js';
import type { Credential as CredentialClass } from './Credential.js';
import type { Integration as IntegrationClass } from './index.js';

let db: TestDatabase;
let models: typeof Models;
let Credential: typeof CredentialClass;
let Integration: typeof IntegrationClass;
let accounts = 0;

before(async () => {
  db = await startTestDatabase('todolist_needs_reconnect_test');
  models = await import('../../models/index.js');
  ({ Credential } = await import('./Credential.js'));
  ({ Integration } = await import('./index.js'));
});

after(async () => {
  await db.stop();
});

async function connection(options: {
  provider: Provider;
  authMethod?: AuthMethod;
  mode?: 'read' | 'read_write';
  demo?: boolean;
  scopes?: string[];
}): Promise<IntegrationClass> {
  accounts += 1;
  const data = await (
    await models.getIntegrationRepository()
  ).create('w-reconnect', {
    connectedBy: 'u-owner',
    provider: options.provider,
    accountId: `account-${String(accounts)}`,
    label: `account ${String(accounts)}`,
    authMethod: options.authMethod ?? 'oauth',
    topicId: 'work',
    mode: options.mode ?? 'read_write',
    demo: options.demo ?? false,
  });
  await Credential.seal({
    workspaceId: data.workspaceId,
    integrationId: data.id,
    provider: data.provider,
    ownerUserId: 'u-owner',
    kind: 'oauth',
    secret: { accessToken: 'FAKE-access-token-0123456789abcdef' },
    scopes: options.scopes ?? [],
  });
  return Integration.from(data);
}

describe('IntegrationStatusView.needsReconnect', () => {
  it('is true for read & write over a Jira grant without write:jira-work', async () => {
    const jira = await connection({ provider: 'jira', scopes: ['read:jira-work'] });
    assert.equal((await jira.toStatusView()).needsReconnect, true);
  });

  it('is true for read & write over a Linear grant without write', async () => {
    const linear = await connection({ provider: 'linear', scopes: ['read'] });
    assert.equal((await linear.toStatusView()).needsReconnect, true);
  });

  it('is false once the grant has the write scope', async () => {
    const jira = await connection({
      provider: 'jira',
      scopes: ['read:jira-work', 'write:jira-work'],
    });
    assert.equal((await jira.toStatusView()).needsReconnect, false);
  });

  it('is false while read-only: nothing waits for the scope', async () => {
    const jira = await connection({ provider: 'jira', mode: 'read', scopes: ['read:jira-work'] });
    assert.equal((await jira.toStatusView()).needsReconnect, false);
  });

  it('is false for a key or token', async () => {
    const jira = await connection({ provider: 'jira', authMethod: 'api_token_basic' });
    assert.equal((await jira.toStatusView()).needsReconnect, false);
  });

  it('is false for demo data', async () => {
    const jira = await connection({ provider: 'jira', demo: true, mode: 'read' });
    assert.equal((await jira.toStatusView()).needsReconnect, false);
  });

  it('is false for a provider that needs no write scope', async () => {
    const github = await connection({ provider: 'github', scopes: ['read:user'] });
    assert.equal((await github.toStatusView()).needsReconnect, false);
  });
});
