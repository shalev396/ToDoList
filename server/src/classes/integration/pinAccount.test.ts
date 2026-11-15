/**
 * Integration#pinAccount (the demo data's stand-in for a first connection test), on a throwaway
 * MongoDB: a demo integration's pending account becomes the given one, once; any other integration
 * is refused (409) and keeps its pending account, since only a connection test proves an account.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { hasStatus } from '../../testing/workspaceFixtures.js';
import type * as IntegrationModule from './index.js';

let db: TestDatabase;
let Integration: typeof IntegrationModule.Integration;

before(async () => {
  db = await startTestDatabase('todolist_classes_pin_account');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  ({ Integration } = await import('./index.js'));
});

after(async () => {
  await db.stop();
});

async function pending(label: string, demo: boolean): Promise<IntegrationModule.Integration> {
  const { getIntegrationRepository } = await import('../../models/index.js');
  const data = await (
    await getIntegrationRepository()
  ).create('w-pin', {
    connectedBy: 'u-owner',
    provider: 'linear',
    accountId: `pending:${label}`,
    label,
    authMethod: 'personal_api_key',
    topicId: null,
    demo,
  });
  return Integration.from(data);
}

describe('Integration#pinAccount', () => {
  it('pins a demo integration’s pending account, once', async () => {
    const demo = await pending('demo', true);
    const pinned = await demo.pinAccount('acct-demo');
    assert.equal(pinned?.accountId, 'acct-demo');
    assert.equal(await demo.pinAccount('acct-again'), null, 'no longer pending');
  });

  it('refuses any other integration, which keeps its pending account', async () => {
    const real = await pending('real', false);
    await assert.rejects(real.pinAccount('acct-forged'), hasStatus(409));
    const { getIntegrationRepository } = await import('../../models/index.js');
    const stored = await (await getIntegrationRepository()).findById('w-pin', real.id);
    assert.equal(stored?.accountId, 'pending:real');
  });
});
