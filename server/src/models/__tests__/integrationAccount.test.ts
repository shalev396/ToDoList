/**
 * An integration's account is fixed (DATA.md §3.4), except for a `pending:` placeholder, which
 * its first successful connection test replaces once with the real account.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { PENDING_ACCOUNT_PREFIX, type IntegrationData } from '../definitions/Integration.js';
import { IntegrationRepository } from '../mongoose/Integration.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase('todolist_integration_account_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
});

after(async () => {
  await db.stop();
});

async function integration(workspaceId: string, accountId: string): Promise<IntegrationData> {
  return IntegrationRepository.create(workspaceId, {
    connectedBy: 'u-owner',
    provider: 'linear',
    accountId,
    label: 'linear',
    authMethod: 'personal_api_key',
    topicId: 'personal',
  });
}

describe('IntegrationRepository.replacePendingAccount', () => {
  it('replaces a pending account once; afterwards the account is fixed', async () => {
    const pending = await integration('w-acc', `${PENDING_ACCOUNT_PREFIX}one`);
    const claimed = await IntegrationRepository.replacePendingAccount('w-acc', pending.id, 'Acme');
    assert.equal(claimed?.accountId, 'Acme');
    assert.equal(
      await IntegrationRepository.replacePendingAccount('w-acc', pending.id, 'Other'),
      null,
    );
    assert.equal((await IntegrationRepository.findById('w-acc', pending.id))?.accountId, 'Acme');
  });

  it('never touches another workspace’s integration, or a deleted one', async () => {
    const pending = await integration('w-acc-a', `${PENDING_ACCOUNT_PREFIX}two`);
    assert.equal(
      await IntegrationRepository.replacePendingAccount('w-acc-b', pending.id, 'X'),
      null,
    );
    await IntegrationRepository.softDelete('w-acc-a', pending.id);
    assert.equal(
      await IntegrationRepository.replacePendingAccount('w-acc-a', pending.id, 'X'),
      null,
    );
  });

  it('an account already connected in the workspace is a duplicate key error (E11000)', async () => {
    await integration('w-acc-dup', 'Taken');
    const pending = await integration('w-acc-dup', `${PENDING_ACCOUNT_PREFIX}three`);
    await assert.rejects(
      IntegrationRepository.replacePendingAccount('w-acc-dup', pending.id, 'Taken'),
      (error: unknown) => (error as { code?: unknown }).code === 11000,
    );
    assert.equal(
      (await IntegrationRepository.findById('w-acc-dup', pending.id))?.accountId,
      `${PENDING_ACCOUNT_PREFIX}three`,
    );
  });
});

describe('IntegrationRepository.findIncludingDeleted (a disconnect resumes)', () => {
  it('finds a live or soft-deleted integration, in its own workspace only', async () => {
    const live = await integration('w-any', 'any-live');
    const gone = await integration('w-any', 'any-gone');
    await IntegrationRepository.softDelete('w-any', gone.id);
    assert.equal((await IntegrationRepository.findIncludingDeleted('w-any', live.id))?.id, live.id);
    const deleted = await IntegrationRepository.findIncludingDeleted('w-any', gone.id);
    assert.ok(deleted?.deletedAt instanceof Date);
    assert.equal(await IntegrationRepository.findById('w-any', gone.id), null);
    assert.equal(await IntegrationRepository.findIncludingDeleted('w-other', gone.id), null);
    assert.equal(await IntegrationRepository.findIncludingDeleted('w-any', 'no-such-id'), null);
  });
});
