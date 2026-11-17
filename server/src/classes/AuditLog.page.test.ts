/**
 * AuditLog.page (audit_log_query's reads) on a throwaway MongoDB: newest first, paged by an opaque
 * cursor until the end (null), filtered by action and agent key, a malformed cursor is a 400, and
 * the integrations its entries are about come with it (a deleted one too; an item a calendar push
 * wrote names its integration in its meta), and the page is immutable.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import { hasStatus } from '../testing/workspaceFixtures.js';
import type { AuditLog as AuditLogClass } from './AuditLog.js';
import { Actor } from './base/Actor.js';
import { AuditTarget } from './base/AuditTarget.js';

let db: TestDatabase;
let AuditLog: typeof AuditLogClass;

before(async () => {
  db = await startTestDatabase('todolist_classes_audit_page');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  ({ AuditLog } = await import('./AuditLog.js'));
});

after(async () => {
  await db.stop();
});

/** Entries at the same millisecond are ordered by id: a tick apart, the order is the writes'. */
function tick(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 5));
}

describe('AuditLog.page', () => {
  it('pages newest first by cursor, filters, and names the integrations its entries are about', async () => {
    const models = await import('../models/index.js');
    const workspaceId = 'w-audit-page';
    const integrations = await models.getIntegrationRepository();
    const jira = await integrations.create(workspaceId, {
      connectedBy: 'u-owner',
      provider: 'jira',
      accountId: 'site.example.invalid',
      label: 'Jira',
      authMethod: 'api_token_basic',
      topicId: null,
    });
    const gcal = await integrations.create(workspaceId, {
      connectedBy: 'u-other',
      provider: 'google_calendar',
      accountId: 'someone@example.invalid',
      label: 'Calendar',
      authMethod: 'oauth',
      topicId: null,
    });
    await integrations.softDelete(workspaceId, gcal.id);
    const person = { workspaceId, actor: Actor.user('u-owner') };
    const agent = { workspaceId, actor: Actor.agent('u-owner', 'agent-1') };
    await AuditLog.record(person, 'workspace.update', AuditTarget.workspace(workspaceId));
    await tick();
    await AuditLog.record(agent, 'mcp.workspace_get', AuditTarget.workspace(workspaceId), {
      resultStatus: 'ok',
    });
    await tick();
    await AuditLog.record(person, 'integration.mode', AuditTarget.of('integration', jira.id));
    await tick();
    await AuditLog.record(person, 'gcal.push', AuditTarget.of('item', 'item-1'), {
      integrationId: gcal.id,
    });
    await tick();
    await AuditLog.record(agent, 'mcp.workspace_get', AuditTarget.workspace(workspaceId));

    const first = await AuditLog.page(workspaceId, { limit: 2 });
    assert.deepEqual(
      first.entries.map((entry) => entry.action),
      ['mcp.workspace_get', 'gcal.push'],
    );
    assert.ok(first.nextCursor !== null);
    const [, push] = first.entries;
    assert.ok(push);
    assert.equal(push.integrationId, gcal.id);
    assert.equal(first.integrationOf(push)?.provider, 'google_calendar');
    assert.equal(first.integrationOf(push)?.ownerUserId, 'u-other');

    const second = await AuditLog.page(workspaceId, { limit: 2, cursor: first.nextCursor });
    assert.deepEqual(
      second.entries.map((entry) => entry.action),
      ['integration.mode', 'mcp.workspace_get'],
    );
    const [mode] = second.entries;
    assert.ok(mode);
    assert.equal(second.integrationOf(mode)?.id, jira.id);
    const last = await AuditLog.page(workspaceId, { limit: 2, cursor: second.nextCursor ?? '' });
    assert.deepEqual(
      last.entries.map((entry) => entry.action),
      ['workspace.update'],
    );
    assert.equal(last.nextCursor, null);
    assert.equal(last.entries[0] && last.integrationOf(last.entries[0]), undefined);

    // A value: the page, its list and what it says of an integration cannot change.
    assert.ok(Object.isFrozen(first) && Object.isFrozen(first.entries));
    assert.throws(() => {
      (first.entries as AuditLogClass[]).push(push);
    }, TypeError);
    const about = first.integrationOf(push);
    assert.ok(about && Object.isFrozen(about));
    assert.throws(() => {
      (about as { ownerUserId: string }).ownerUserId = 'u-someone-else';
    }, TypeError);
    assert.equal(first.integrationOf(push)?.ownerUserId, 'u-other');

    const byAgent = await AuditLog.page(workspaceId, { limit: 10, actorAgentId: 'agent-1' });
    assert.equal(byAgent.entries.length, 2);
    const byAction = await AuditLog.page(workspaceId, { limit: 10, action: 'integration.mode' });
    assert.deepEqual(
      byAction.entries.map((entry) => entry.targetId),
      [jira.id],
    );
  });

  it('refuses a cursor it did not make', async () => {
    await assert.rejects(
      AuditLog.page('w-audit-page', { limit: 2, cursor: 'not-a-cursor' }),
      (error: unknown) =>
        hasStatus(400)(error) &&
        (error as Error).message === 'cursor: invalid; pass the nextCursor of the previous page',
    );
  });
});
