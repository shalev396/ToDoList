import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { containerSourceHash, itemSourceHash } from '../../sync/hash.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { BUILTIN_IMPORTANCE } from '../../types/attributes.js';
import type { IntegrationStatus } from '../../types/domain.js';
import type { SourceRef } from '../definitions/common.js';
import type { ContainerFilter, ContainerUpsert } from '../definitions/Container.js';
import type { CreateIntegrationInput } from '../definitions/Integration.js';
import type { SyncRunData } from '../definitions/SyncRun.js';
import { localItemUrl, type ItemUpsert, type SweepWindow } from '../definitions/Item.js';
import { MirroredItemError } from '../errors.js';
import { AgentKeyMongoModel, AgentKeyRepository } from '../mongoose/AgentKey.js';
import { AuditLogRepository } from '../mongoose/AuditLog.js';
import { CalendarLinkRepository } from '../mongoose/CalendarLink.js';
import { ContainerMongoModel, ContainerRepository } from '../mongoose/Container.js';
import { DashboardRepository } from '../mongoose/Dashboard.js';
import {
  DashboardVersionMongoModel,
  DashboardVersionRepository,
} from '../mongoose/DashboardVersion.js';
import { IntegrationMongoModel, IntegrationRepository } from '../mongoose/Integration.js';
import { InviteRepository } from '../mongoose/Invite.js';
import { ItemMongoModel, ItemRepository } from '../mongoose/Item.js';
import { MembershipRepository } from '../mongoose/Membership.js';
import { ReplayNonceRepository } from '../mongoose/ReplayNonce.js';
import { SyncRunRepository } from '../mongoose/SyncRun.js';
import { SyncStateRepository } from '../mongoose/SyncState.js';
import { UserRepository } from '../mongoose/User.js';
import { ViewRepository } from '../mongoose/View.js';
import { WorkspaceRepository } from '../mongoose/Workspace.js';

const DAY = 24 * 60 * 60 * 1000;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase('todolist_repositories_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
});

after(async () => {
  await db.stop();
});

describe('UserRepository (MongoDB)', () => {
  it('starts without a default workspace, then sets and clears it', async () => {
    const user = await UserRepository.upsert({
      cognitoSub: 'sub-default-ws',
      email: 'Default.WS@Example.invalid',
      name: 'Default',
      lastLoginAt: new Date(),
    });
    assert.equal(user.defaultWorkspaceId, null);
    const set = await UserRepository.setDefaultWorkspace(user.id, 'w-default');
    assert.equal(set.defaultWorkspaceId, 'w-default');
    assert.equal((await UserRepository.findById(user.id))?.defaultWorkspaceId, 'w-default');
    const cleared = await UserRepository.setDefaultWorkspace(user.id, null);
    assert.equal(cleared.defaultWorkspaceId, null);
  });

  it('findByEmail matches whatever the case', async () => {
    await UserRepository.upsert({
      cognitoSub: 'sub-find-email',
      email: 'Mixed.Case@Example.invalid',
      name: 'Mixed',
      lastLoginAt: new Date(),
    });
    assert.equal(
      (await UserRepository.findByEmail('mixed.case@example.invalid'))?.cognitoSub,
      'sub-find-email',
    );
    assert.equal(
      (await UserRepository.findByEmail(' MIXED.CASE@EXAMPLE.INVALID '))?.cognitoSub,
      'sub-find-email',
    );
    assert.equal(await UserRepository.findByEmail('nobody@example.invalid'), null);
  });
});

describe('WorkspaceRepository', () => {
  it('creates a workspace with a UUID id and the default settings', async () => {
    const workspace = await WorkspaceRepository.create({
      name: 'Defaults',
      slug: 'defaults',
      ownerId: 'u-1',
    });
    assert.match(workspace.id, UUID);
    assert.deepEqual(workspace.settings, {
      timezone: 'Asia/Jerusalem',
      weekStart: 'sun',
      topicRules: [],
      allowAgentPublish: false,
      attributes: [BUILTIN_IMPORTANCE],
    });
    assert.equal(workspace.deletedAt, null);
    assert.ok(!('_id' in workspace));
  });

  it('updates only the settings given', async () => {
    const workspace = await WorkspaceRepository.create({
      name: 'Settings',
      slug: 'settings',
      ownerId: 'u-1',
      settings: { weekStart: 'mon' },
    });
    const updated = await WorkspaceRepository.update(workspace.id, {
      name: 'Renamed',
      settings: { topicRules: [{ match: 'shalev396/*', topicId: 'personal' }] },
    });
    assert.ok(updated);
    assert.equal(updated.name, 'Renamed');
    assert.deepEqual(updated.settings, {
      timezone: 'Asia/Jerusalem',
      weekStart: 'mon',
      topicRules: [{ match: 'shalev396/*', topicId: 'personal' }],
      allowAgentPublish: false,
      attributes: [BUILTIN_IMPORTANCE],
    });
  });

  it('a soft-deleted workspace is gone from findById and listByIds, but keeps its slug', async () => {
    const workspace = await WorkspaceRepository.create({
      name: 'Gone',
      slug: 'gone',
      ownerId: 'u-1',
    });
    assert.equal(await WorkspaceRepository.softDelete(workspace.id), true);
    assert.equal(await WorkspaceRepository.softDelete(workspace.id), false);
    assert.equal(await WorkspaceRepository.findById(workspace.id), null);
    assert.deepEqual(await WorkspaceRepository.listByIds([workspace.id]), []);
    assert.equal((await WorkspaceRepository.findBySlug('gone'))?.id, workspace.id);
    assert.equal(await WorkspaceRepository.update(workspace.id, { name: 'Back' }), null);
  });
});

describe('MembershipRepository', () => {
  it('reactivates a revoked membership and refuses a duplicate active one', async () => {
    const created = await MembershipRepository.create('w-members', {
      userId: 'u-member',
      role: 'editor',
      invitedBy: 'u-owner',
    });
    assert.equal(created.status, 'active');
    await assert.rejects(
      MembershipRepository.create('w-members', { userId: 'u-member', role: 'viewer' }),
      (error: unknown) => (error as { code?: unknown }).code === 11000,
    );

    assert.equal(await MembershipRepository.revoke('w-members', 'u-member'), true);
    assert.equal(await MembershipRepository.find('w-members', 'u-member'), null);
    assert.equal(await MembershipRepository.countActive('w-members'), 0);

    const again = await MembershipRepository.create('w-members', {
      userId: 'u-member',
      role: 'viewer',
    });
    assert.equal(again.id, created.id);
    assert.deepEqual([again.status, again.role, again.invitedBy], ['active', 'viewer', null]);
    assert.equal((await MembershipRepository.findForUser('u-member')).length, 1);
  });

  it('updates the role of active members only, and counts owners', async () => {
    await MembershipRepository.create('w-roles', { userId: 'u-a', role: 'owner' });
    await MembershipRepository.create('w-roles', { userId: 'u-b', role: 'viewer' });
    const promoted = await MembershipRepository.update('w-roles', 'u-b', { role: 'owner' });
    assert.ok(promoted);
    assert.equal(promoted.role, 'owner');
    assert.equal(Object.keys(promoted).includes('areaScope'), false, 'no area scope any more');
    assert.equal(await MembershipRepository.countOwners('w-roles'), 2);
    await MembershipRepository.revoke('w-roles', 'u-b');
    assert.equal(await MembershipRepository.countOwners('w-roles'), 1);
    assert.equal(await MembershipRepository.update('w-roles', 'u-b', { role: 'viewer' }), null);
    assert.deepEqual(
      (await MembershipRepository.listMembers('w-roles')).map((member) => member.userId),
      ['u-a'],
    );
  });
});

describe('InviteRepository', () => {
  const email = 'Invitee@Example.invalid';

  it('listPendingForEmail excludes expired and accepted invites', async () => {
    const now = Date.now();
    const pending = await InviteRepository.create('w-inv-1', {
      email,
      role: 'viewer',
      tokenHash: 'hash-pending',
      expiresAt: new Date(now + 7 * DAY),
      invitedBy: 'u-owner',
    });
    assert.equal(pending.email, 'invitee@example.invalid');
    assert.ok(!('tokenHash' in pending));
    await InviteRepository.create('w-inv-2', {
      email,
      role: 'viewer',
      tokenHash: 'hash-expired',
      expiresAt: new Date(now - DAY),
      invitedBy: 'u-owner',
    });
    const accepted = await InviteRepository.create('w-inv-3', {
      email,
      role: 'editor',
      tokenHash: 'hash-accepted',
      expiresAt: new Date(now + 7 * DAY),
      invitedBy: 'u-owner',
    });
    assert.ok(await InviteRepository.markAccepted('w-inv-3', accepted.id, 'u-invitee'));

    const listed = await InviteRepository.listPendingForEmail('INVITEE@example.invalid');
    assert.deepEqual(
      listed.map((invite) => invite.id),
      [pending.id],
    );
  });

  it('accepts an invite once, and never after it is revoked', async () => {
    const invite = await InviteRepository.create('w-inv-4', {
      email: 'once@example.invalid',
      role: 'viewer',
      tokenHash: 'hash-once',
      expiresAt: new Date(Date.now() + DAY),
      invitedBy: 'u-owner',
    });
    assert.equal((await InviteRepository.findByTokenHash('hash-once'))?.id, invite.id);
    const accepted = await InviteRepository.markAccepted('w-inv-4', invite.id, 'u-invitee');
    assert.ok(accepted);
    assert.equal(accepted.status, 'accepted');
    assert.equal(accepted.acceptedBy, 'u-invitee');
    assert.ok(accepted.acceptedAt instanceof Date);
    assert.equal(await InviteRepository.markAccepted('w-inv-4', invite.id, 'u-other'), null);
    assert.equal((await InviteRepository.findByTokenHash('hash-once'))?.status, 'accepted');

    const revoked = await InviteRepository.create('w-inv-4', {
      email: 'revoked@example.invalid',
      role: 'viewer',
      tokenHash: 'hash-revoked',
      expiresAt: new Date(Date.now() + DAY),
      invitedBy: 'u-owner',
    });
    assert.equal(await InviteRepository.revoke('w-inv-4', revoked.id), true);
    assert.equal(await InviteRepository.markAccepted('w-inv-4', revoked.id, 'u-invitee'), null);
    assert.deepEqual(
      (await InviteRepository.listForWorkspace('w-inv-4')).map((i) => i.status).sort(),
      ['accepted', 'revoked'],
    );
  });
});

describe('IntegrationRepository', () => {
  function input(
    accountId: string,
    extra: Partial<CreateIntegrationInput> = {},
  ): CreateIntegrationInput {
    return {
      connectedBy: 'u-owner',
      provider: 'linear',
      accountId,
      label: `Linear ${accountId}`,
      authMethod: 'personal_api_key',
      topicId: 'personal',
      ...extra,
    };
  }

  it('creates with read mode, active status and empty config, and updates only listed fields', async () => {
    const created = await IntegrationRepository.create('w-int', input('workspace-1'));
    assert.deepEqual(
      [created.mode, created.status, created.config, created.credentialId, created.lastError],
      ['read', 'active', {}, null, null],
    );
    const updated = await IntegrationRepository.update('w-int', created.id, {
      label: 'Personal Linear',
      lastError: { code: 'HTTP_401', message: 'unauthorized' },
      ...({ provider: 'jira', workspaceId: 'w-other' } as object),
    });
    assert.ok(updated);
    assert.equal(updated.label, 'Personal Linear');
    assert.deepEqual(updated.lastError, { code: 'HTTP_401', message: 'unauthorized' });
    assert.deepEqual([updated.provider, updated.workspaceId], ['linear', 'w-int']);
  });

  it('an integration the owners migration missed is nobody’s own, never its connecting member’s', async () => {
    const created = await IntegrationRepository.create('w-int-unmigrated', input('workspace-u'));
    assert.equal(created.ownerUserId, 'u-owner');
    await IntegrationMongoModel.collection.updateOne(
      { _id: created.id as never },
      { $unset: { ownerUserId: '' } },
    );
    const { IntegrationPolicy } = await import('../../classes/policies/IntegrationPolicy.js');
    const stored = await IntegrationRepository.findById('w-int-unmigrated', created.id);
    assert.ok(stored);
    assert.equal(IntegrationPolicy.isOwn(stored, 'u-owner'), false);
    assert.deepEqual(await IntegrationRepository.listForOwner('w-int-unmigrated', 'u-owner'), []);
  });

  it('a workspace deletion knows whose integrations it removed, even when it resumes', async () => {
    const W = 'w-int-deletion';
    const live = await IntegrationRepository.create(
      W,
      input('del-live', { connectedBy: 'u-live' }),
    );
    const earlier = await IntegrationRepository.create(
      W,
      input('del-old', { connectedBy: 'u-old' }),
    );
    await IntegrationRepository.softDelete(W, earlier.id);
    assert.deepEqual(await IntegrationRepository.listOwnersForWorkspaceDeletion(W), ['u-live']);
    await IntegrationRepository.softDeleteForWorkspace(W);
    // Deleted with the workspace: still its owner's to be told; one disconnected before: not.
    assert.deepEqual(await IntegrationRepository.listOwnersForWorkspaceDeletion(W), ['u-live']);
    assert.equal(await IntegrationRepository.findById(W, live.id), null);
  });

  it('soft delete hides it, frees its account for a new connection and stops counting it', async () => {
    const first = await IntegrationRepository.create('w-int-del', input('workspace-2'));
    await assert.rejects(
      IntegrationRepository.create('w-int-del', input('workspace-2')),
      (error: unknown) => (error as { code?: unknown }).code === 11000,
    );
    assert.equal(await IntegrationRepository.countActive('w-int-del'), 1);
    assert.equal(await IntegrationRepository.softDelete('w-int-del', first.id), true);
    assert.equal(await IntegrationRepository.findById('w-int-del', first.id), null);
    assert.equal(await IntegrationRepository.findByIdForWorker(first.id), null);
    assert.deepEqual(await IntegrationRepository.list('w-int-del'), []);
    assert.equal(await IntegrationRepository.countActive('w-int-del'), 0);
    const second = await IntegrationRepository.create('w-int-del', input('workspace-2'));
    assert.equal((await IntegrationRepository.findByIdForWorker(second.id))?.id, second.id);
  });

  it('softDeleteForWorkspace hides every integration of that workspace only', async () => {
    await IntegrationRepository.create('w-int-workspace', input('workspace-a'));
    await IntegrationRepository.create('w-int-workspace', input('workspace-b'));
    const kept = await IntegrationRepository.create('w-int-kept', input('workspace-a'));
    assert.equal(await IntegrationRepository.softDeleteForWorkspace('w-int-workspace'), 2);
    assert.deepEqual(await IntegrationRepository.list('w-int-workspace'), []);
    assert.equal((await IntegrationRepository.findById('w-int-kept', kept.id))?.id, kept.id);
    assert.equal(await IntegrationRepository.softDeleteForWorkspace('w-int-workspace'), 0);
  });

  it('findIncludingDeletedForWorker finds an integration by id alone, soft-deleted or not', async () => {
    const w = 'w-int-any';
    const created = await IntegrationRepository.create(w, {
      connectedBy: 'u-owner',
      provider: 'jira',
      accountId: 'any.example.invalid',
      label: 'Jira',
      authMethod: 'api_token_basic',
      topicId: 'work',
    });
    assert.equal(
      (await IntegrationRepository.findIncludingDeletedForWorker(created.id))?.id,
      created.id,
    );
    await IntegrationRepository.softDelete(w, created.id);
    assert.equal(await IntegrationRepository.findByIdForWorker(created.id), null);
    const deleted = await IntegrationRepository.findIncludingDeletedForWorker(created.id);
    assert.deepEqual([deleted?.workspaceId, deleted?.deletedAt instanceof Date], [w, true]);
    assert.equal(await IntegrationRepository.findIncludingDeletedForWorker('no-such-id'), null);
  });

  it('recordSyncResult writes lastSyncAt and lastError, and the status unless paused or expired', async () => {
    const w = 'w-int-result';
    const at = new Date('2026-11-12T08:00:00Z');
    const failure = { code: 'network', message: 'Could not reach the provider' };
    const active = await IntegrationRepository.create(w, input('r-active'));
    const failed = await IntegrationRepository.recordSyncResult(w, active.id, {
      status: 'error',
      lastSyncAt: at,
      lastError: failure,
    });
    assert.deepEqual(
      [failed?.status, failed?.lastSyncAt, failed?.lastError],
      ['error', at, failure],
    );

    for (const held of ['paused', 'expired'] as const) {
      const integration = await IntegrationRepository.create(
        w,
        input(`r-${held}`, { status: held }),
      );
      const after = await IntegrationRepository.recordSyncResult(w, integration.id, {
        status: 'active',
        lastSyncAt: at,
        lastError: null,
      });
      assert.deepEqual([after?.status, after?.lastSyncAt, after?.lastError], [held, at, null]);
    }

    const deleted = await IntegrationRepository.create(w, input('r-deleted'));
    await IntegrationRepository.softDelete(w, deleted.id);
    const update = { status: 'active' as const, lastError: null };
    assert.equal(await IntegrationRepository.recordSyncResult(w, deleted.id, update), null);
    assert.equal(await IntegrationRepository.recordSyncResult('w-other', active.id, update), null);
    assert.equal((await IntegrationRepository.findById(w, active.id))?.status, 'error');
  });

  it('dispatches active, expiring and errored integrations, not expired, paused, deleted or auth-failed ones', async () => {
    const statuses: IntegrationStatus[] = ['active', 'expiring', 'expired', 'error', 'paused'];
    const ids = new Map<string, IntegrationStatus>();
    for (const status of statuses) {
      const created = await IntegrationRepository.create(
        'w-dispatch',
        input(`d-${status}`, { status }),
      );
      ids.set(created.id, status);
    }
    const deleted = await IntegrationRepository.create('w-dispatch', input('d-deleted'));
    await IntegrationRepository.softDelete('w-dispatch', deleted.id);
    // Needs a reconnect: retrying would only fail again.
    const reconnect = await IntegrationRepository.create('w-dispatch', input('d-auth'));
    await IntegrationRepository.update('w-dispatch', reconnect.id, {
      status: 'error',
      lastError: { code: 'auth_failed', message: 'Reconnect required' },
    });

    const dispatched = (await IntegrationRepository.listActiveForDispatch())
      .filter((integration) => integration.workspaceId === 'w-dispatch')
      .map((integration) => ids.get(integration.id))
      .sort();
    assert.deepEqual(dispatched, ['active', 'error', 'expiring']);
  });
});

function jiraSource(externalId: string, hash: string | null): SourceRef {
  return {
    provider: 'jira',
    accountId: 'site.example.invalid',
    externalId,
    key: `ADS-${externalId}`,
    url: `https://example.invalid/browse/ADS-${externalId}`,
    updatedAtSource: null,
    etag: null,
    hash,
  };
}

function jiraIssue(
  externalId: string,
  hash: string | null,
  extra: Partial<ItemUpsert> = {},
): ItemUpsert {
  return {
    integrationId: 'i-jira',
    kind: 'issue',
    topicId: 'work',
    title: `Issue ${externalId}`,
    status: 'open',
    source: jiraSource(externalId, hash),
    ...extra,
  };
}

/** The `_id` of a mirrored item, looked up by its external id. */
async function mirroredId(workspaceId: string, externalId: string): Promise<string> {
  const [row] = await ItemRepository.aggregate<{ _id: string }>(workspaceId, [
    { $match: { 'source.externalId': externalId } },
    { $project: { _id: 1 } },
  ]);
  assert.ok(row, `no item ${externalId}`);
  return row._id;
}

describe('ItemRepository', () => {
  it('createLocal makes a local item whose source points back at it', async () => {
    const item = await ItemRepository.createLocal('w-items', {
      ownerUserId: 'u-owner',
      title: 'Buy milk',
      topicId: 'personal',
    });
    assert.match(item.id, UUID);
    assert.deepEqual(item.source, {
      provider: 'local',
      accountId: '',
      externalId: item.id,
      key: null,
      url: localItemUrl('w-items', item.id),
      updatedAtSource: null,
      etag: null,
      hash: null,
    });
    assert.deepEqual(
      [item.kind, item.status, item.integrationId, item.visibility, item.ownerUserId],
      ['todo', 'open', null, 'workspace', 'u-owner'],
    );
    assert.deepEqual(item.overlay, {
      pinned: null,
      note: null,
      hidden: null,
      topicOverride: null,
      calendarSync: null,
      plannedAt: null,
      editedAt: null,
      copyOf: null,
      copyOfOwner: null,
      copyOfShared: null,
      attrs: {},
      overrides: {
        title: null,
        status: null,
        dueAt: null,
        allDay: null,
        startAt: null,
        priority: null,
      },
    });
    assert.deepEqual([item.props, item.assignees, item.linkedItemIds], [{}, [], []]);
  });

  it('updateLocal edits a local item and throws MirroredItemError on a mirrored one', async () => {
    const local = await ItemRepository.createLocal('w-items', {
      ownerUserId: 'u-owner',
      title: 'Draft',
      topicId: 'personal',
    });
    const edited = await ItemRepository.updateLocal('w-items', local.id, {
      title: 'Final',
      status: 'done',
      ...({ source: { provider: 'jira' }, workspaceId: 'w-other' } as object),
    });
    assert.ok(edited);
    assert.deepEqual([edited.title, edited.status], ['Final', 'done']);
    assert.deepEqual([edited.source.provider, edited.workspaceId], ['local', 'w-items']);

    await ItemRepository.bulkUpsert('w-items', [jiraIssue('100', 'sha1:a')]);
    const id = await mirroredId('w-items', '100');
    await assert.rejects(
      ItemRepository.updateLocal('w-items', id, { title: 'Edited here' }),
      (error: unknown) =>
        error instanceof MirroredItemError &&
        error.itemId === id &&
        error.provider === 'jira' &&
        error.url === 'https://example.invalid/browse/ADS-100',
    );
    assert.equal((await ItemRepository.findById('w-items', id))?.title, 'Issue 100');
    assert.equal(await ItemRepository.updateLocal('w-items', 'missing', { title: 'x' }), null);
  });

  it('setOverlay changes only the overlay fields given, on mirrored items too', async () => {
    await ItemRepository.bulkUpsert('w-items', [jiraIssue('101', 'sha1:a')]);
    const id = await mirroredId('w-items', '101');
    await ItemRepository.setOverlay('w-items', id, { pinned: true, note: 'ask Dana' });
    const item = await ItemRepository.setOverlay('w-items', id, { hidden: false });
    assert.deepEqual(item?.overlay, {
      pinned: true,
      note: 'ask Dana',
      hidden: false,
      topicOverride: null,
      calendarSync: null,
      plannedAt: null,
      editedAt: null,
      copyOf: null,
      copyOfOwner: null,
      copyOfShared: null,
      attrs: {},
      overrides: {
        title: null,
        status: null,
        dueAt: null,
        allDay: null,
        startAt: null,
        priority: null,
      },
    });
  });

  it('setOverlay sets and clears overrides, and a sync of the record never touches them', async () => {
    await ItemRepository.bulkUpsert('w-items', [jiraIssue('102', 'sha1:a')]);
    const id = await mirroredId('w-items', '102');
    const due = new Date('2026-12-01T00:00:00.000Z');
    const set = await ItemRepository.setOverlay('w-items', id, {
      overrides: { startAt: due, priority: 3 },
    });
    assert.deepEqual(
      [
        set?.overlay.overrides.startAt,
        set?.overlay.overrides.priority,
        set?.overlay.overrides.title,
      ],
      [due, 3, null],
    );
    // The record changes at the provider: the sync rewrites what it owns, never the overrides.
    await ItemRepository.bulkUpsert('w-items', [
      { ...jiraIssue('102', 'sha1:b'), title: 'Renamed there' },
    ]);
    const synced = await ItemRepository.findById('w-items', id);
    assert.equal(synced?.title, 'Renamed there');
    assert.deepEqual(
      [synced.overlay.overrides.startAt, synced.overlay.overrides.priority],
      [due, 3],
    );
    const cleared = await ItemRepository.setOverlay('w-items', id, {
      overrides: { startAt: null },
    });
    assert.deepEqual(
      [cleared?.overlay.overrides.startAt, cleared?.overlay.overrides.priority],
      [null, 3],
    );
  });

  it('softDelete hides the item', async () => {
    const item = await ItemRepository.createLocal('w-items', {
      ownerUserId: 'u-owner',
      title: 'Temporary',
      topicId: 'work',
    });
    assert.equal(await ItemRepository.softDelete('w-items', item.id), true);
    assert.equal(await ItemRepository.softDelete('w-items', item.id), false);
    assert.equal(await ItemRepository.findById('w-items', item.id), null);
  });

  it('softDeleteForWorkspace hides every item of that workspace only, local and mirrored', async () => {
    const local = await ItemRepository.createLocal('w-items-workspace', {
      ownerUserId: 'u-owner',
      title: 'Workspace todo',
      topicId: 'work',
    });
    await ItemRepository.bulkUpsert('w-items-workspace', [jiraIssue('900', 'sha1:a')]);
    const kept = await ItemRepository.createLocal('w-items-kept', {
      ownerUserId: 'u-owner',
      title: 'Other workspace todo',
      topicId: 'work',
    });
    assert.equal(await ItemRepository.softDeleteForWorkspace('w-items-workspace'), 2);
    assert.equal(await ItemRepository.findById('w-items-workspace', local.id), null);
    const live = await ItemMongoModel.countDocuments({
      workspaceId: 'w-items-workspace',
      deletedAt: null,
    });
    assert.equal(live, 0);
    // Soft: the rows stay for the purge job.
    assert.equal(await ItemMongoModel.countDocuments({ workspaceId: 'w-items-workspace' }), 2);
    assert.equal(
      (await ItemRepository.findById('w-items-kept', kept.id))?.title,
      'Other workspace todo',
    );
    assert.equal(await ItemRepository.softDeleteForWorkspace('w-items-workspace'), 0);
  });

  it('bulkUpsert counts inserted, updated and unchanged by source.hash', async () => {
    const first = await ItemRepository.bulkUpsert('w-sync', [
      jiraIssue('1', 'sha1:one', { dueAt: new Date('2026-11-15T21:59:00Z') }),
      jiraIssue('2', 'sha1:two', { dueAt: new Date('2026-11-16T21:59:00Z') }),
    ]);
    assert.deepEqual(first, { inserted: 2, updated: 0, unchanged: 0, closed: 0 });
    const oneId = await mirroredId('w-sync', '1');
    const twoId = await mirroredId('w-sync', '2');
    const oneBefore = await ItemRepository.findById('w-sync', oneId);
    assert.ok(oneBefore?.lastSeenAt);
    await ItemRepository.setOverlay('w-sync', twoId, { pinned: true });
    await new Promise((resolve) => setTimeout(resolve, 20));

    const second = await ItemRepository.bulkUpsert('w-sync', [
      // Same hash: nothing but lastSeenAt is written, even though the payload differs.
      jiraIssue('1', 'sha1:one', { title: 'Ignored title' }),
      // New hash, and no dueAt any more: the item is rewritten and dueAt cleared.
      jiraIssue('2', 'sha1:two-v2', { title: 'Renamed at source' }),
      jiraIssue('3', 'sha1:three'),
    ]);
    assert.deepEqual(second, { inserted: 1, updated: 1, unchanged: 1, closed: 0 });

    const one = await ItemRepository.findById('w-sync', oneId);
    assert.ok(one?.lastSeenAt);
    assert.equal(one.title, 'Issue 1');
    assert.deepEqual(one.dueAt, oneBefore.dueAt);
    assert.deepEqual(one.updatedAt, oneBefore.updatedAt);
    assert.ok(one.lastSeenAt > oneBefore.lastSeenAt, 'lastSeenAt moves on');

    const two = await ItemRepository.findById('w-sync', twoId);
    assert.ok(two);
    assert.deepEqual(
      [two.title, two.dueAt, two.source.hash],
      ['Renamed at source', null, 'sha1:two-v2'],
    );
    assert.equal(two.overlay.pinned, true, 'the sync never touches the overlay');
    const three = await ItemRepository.findById('w-sync', await mirroredId('w-sync', '3'));
    assert.deepEqual([three?.visibility, three?.overlay.pinned], ['workspace', null]);
  });

  it('bulkUpsert stamps syncResource on every write, unchanged ones too, without an updatedAt bump', async () => {
    const w = 'w-sync-resource';
    const local = await ItemRepository.createLocal(w, {
      ownerUserId: 'u-owner',
      title: 'Local',
      topicId: 'personal',
    });
    assert.equal(local.syncResource, null, 'local items belong to no resource');

    await ItemRepository.bulkUpsert(w, [jiraIssue('r1', 'sha1:r1', { syncResource: 'issues' })]);
    const id = await mirroredId(w, 'r1');
    const first = await ItemRepository.findById(w, id);
    assert.equal(first?.syncResource, 'issues');
    await new Promise((resolve) => setTimeout(resolve, 20));

    // Same hash, seen by another resource now: unchanged, yet the stamp follows it.
    const again = await ItemRepository.bulkUpsert(w, [
      jiraIssue('r1', 'sha1:r1', { syncResource: 'boards' }),
    ]);
    assert.equal(again.unchanged, 1);
    const moved = await ItemRepository.findById(w, id);
    assert.equal(moved?.syncResource, 'boards');
    assert.deepEqual(moved.updatedAt, first.updatedAt);

    // A changed record is rewritten with its stamp; none given is written as null.
    await ItemRepository.bulkUpsert(w, [jiraIssue('r1', 'sha1:r1-v2', { syncResource: 'issues' })]);
    assert.equal((await ItemRepository.findById(w, id))?.syncResource, 'issues');
    await ItemRepository.bulkUpsert(w, [jiraIssue('r1', 'sha1:r1-v2')]);
    assert.equal((await ItemRepository.findById(w, id))?.syncResource, null);
  });

  it('bulkUpsert compares a stored hash of another algorithm field by field, once', async () => {
    const w = 'w-rehash';
    const fields: Partial<ItemUpsert> = {
      dueAt: new Date('2026-11-20T09:00:00Z'),
      labels: ['a', 'b'],
      assignees: ['ann'],
      props: { points: 3, sprint: { name: 'S1', endsAt: new Date('2026-11-30T00:00:00Z') } },
      // Longer than the stored preview: the comparison reads what a write would store.
      bodyPreview: 'x'.repeat(600),
    };
    await ItemRepository.bulkUpsert(w, [
      jiraIssue('same', 'sha1:same', fields),
      jiraIssue('moved', 'sha1:moved', fields),
      jiraIssue('closing', 'sha1:closing'),
    ]);
    const sameId = await mirroredId(w, 'same');
    const before = await ItemRepository.findById(w, sameId);
    assert.ok(before?.lastSeenAt);
    await new Promise((resolve) => setTimeout(resolve, 20));

    const later = new Date('2026-11-21T09:00:00Z');
    const result = await ItemRepository.bulkUpsert(w, [
      // Only volatile source fields changed: unchanged, and it takes the new hash.
      jiraIssue('same', 'sha256:same', {
        ...fields,
        syncResource: 'issues',
        source: { ...jiraSource('same', 'sha256:same'), etag: 'e2', updatedAtSource: later },
      }),
      // A new due date: written in full.
      jiraIssue('moved', 'sha256:moved', { ...fields, dueAt: later }),
      // Closed at the provider: written, and counted as closed.
      jiraIssue('closing', 'sha256:closing', { status: 'done', closedAt: later }),
    ]);
    assert.deepEqual(result, { inserted: 0, updated: 2, unchanged: 1, closed: 1 });

    const same = await ItemRepository.findById(w, sameId);
    assert.ok(same?.lastSeenAt);
    assert.deepEqual(same.updatedAt, before.updatedAt, 'no updatedAt bump');
    assert.ok(same.lastSeenAt > before.lastSeenAt, 'lastSeenAt moves on');
    assert.deepEqual(
      [same.source.hash, same.source.etag, same.syncResource, same.bodyPreview?.length],
      ['sha256:same', null, 'issues', 500],
    );
    const moved = await ItemRepository.findById(w, await mirroredId(w, 'moved'));
    assert.deepEqual([moved?.dueAt, moved?.source.hash], [later, 'sha256:moved']);

    // From now on the hashes compare as before: same hash unchanged, another one a full write.
    assert.deepEqual(
      await ItemRepository.bulkUpsert(w, [
        jiraIssue('same', 'sha256:same', fields),
        jiraIssue('moved', 'sha256:moved-v2', { ...fields, dueAt: later }),
      ]),
      { inserted: 0, updated: 1, unchanged: 1, closed: 0 },
    );
  });

  it('bulkUpsert never counts a copy changed that the old hash would have matched', async () => {
    const w = 'w-rehash-as-stored';
    const invalid = (): Date => new Date(Number.NaN);
    // [external id, mapped then (stored under sha1:), mapped now]. MongoDB stores an undefined
    // under a key as null, where the hash dropped it, and an invalid date as the epoch, where the
    // hash read null; a mapping may also have spelled a value one way then and another now.
    const matching: [string, Partial<ItemUpsert>, Partial<ItemUpsert>][] = [
      [
        'undefined',
        { props: { a: undefined, b: { c: undefined, k: 1 }, list: [{ d: undefined }, undefined] } },
        { props: { a: undefined, b: { c: undefined, k: 1 }, list: [{ d: undefined }, undefined] } },
      ],
      ['undefined-now', { props: { b: { k: 1 } } }, { props: { a: undefined, b: { k: 1 } } }],
      ['undefined-then', { props: { a: undefined } }, { props: {} }],
      [
        'invalid-date',
        { props: { at: invalid(), b: { at: invalid() }, list: [invalid()] } },
        { props: { at: invalid(), b: { at: invalid() }, list: [invalid()] } },
      ],
      [
        'invalid-then',
        { props: { at: invalid(), list: [invalid()] } },
        { props: { at: null, list: [null] } },
      ],
      [
        'invalid-now',
        { props: { at: null, n: Number.NaN } },
        { props: { at: invalid(), n: null } },
      ],
      // A typed date: the hash reads an invalid one as null (and Mongoose would refuse to store it).
      ['invalid-due', { dueAt: null }, { dueAt: invalid() }],
    ];
    // Real changes inside props are still written.
    const changing: [string, Partial<ItemUpsert>, Partial<ItemUpsert>][] = [
      ['nested', { props: { b: { k: 1 } } }, { props: { b: { c: undefined, k: 2 } } }],
      ['dropped', { props: { a: 1 } }, { props: { a: undefined } }],
      ['dated', { props: { at: new Date('2026-11-20T09:00:00Z') } }, { props: { at: invalid() } }],
    ];
    for (const [id, then, now] of matching) {
      // The same stable JSON, so the old SHA-1 of it matched too.
      assert.equal(
        itemSourceHash(jiraIssue(id, null, then)),
        itemSourceHash(jiraIssue(id, null, now)),
        `${id}: the old hash would have matched`,
      );
    }
    for (const [id, then, now] of changing) {
      assert.notEqual(
        itemSourceHash(jiraIssue(id, null, then)),
        itemSourceHash(jiraIssue(id, null, now)),
        `${id}: a real change`,
      );
    }

    const all = [...matching, ...changing];
    await ItemRepository.bulkUpsert(
      w,
      all.map(([id, then]) => jiraIssue(id, `sha1:${id}`, then)),
    );
    const before = new Map<string, Date | undefined>();
    for (const [id] of all) {
      before.set(id, (await ItemRepository.findById(w, await mirroredId(w, id)))?.updatedAt);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));

    assert.deepEqual(
      await ItemRepository.bulkUpsert(
        w,
        all.map(([id, , now]) => jiraIssue(id, `sha256:${id}`, now)),
      ),
      { inserted: 0, updated: changing.length, unchanged: matching.length, closed: 0 },
    );
    for (const [id] of matching) {
      const item = await ItemRepository.findById(w, await mirroredId(w, id));
      assert.deepEqual(
        [item?.updatedAt, item?.source.hash],
        [before.get(id), `sha256:${id}`],
        `${id}: unchanged, no updatedAt bump`,
      );
    }
    for (const [id] of changing) {
      const item = await ItemRepository.findById(w, await mirroredId(w, id));
      assert.ok(item && item.updatedAt > (before.get(id) ?? item.updatedAt), `${id}: written`);
    }
  });

  it('bulkUpsert counts the items it closes: stored not closed, now done or cancelled with closedAt', async () => {
    const w = 'w-closed';
    const closedAt = new Date('2026-11-10T09:00:00Z');
    assert.deepEqual(
      await ItemRepository.bulkUpsert(w, [
        jiraIssue('open', 'h1'),
        jiraIssue('progress', 'h1', { status: 'in_progress' }),
        jiraIssue('no-date', 'h1'),
        jiraIssue('was-done', 'h1', { status: 'done', closedAt }),
        jiraIssue('gone', 'h1'),
      ]),
      { inserted: 5, updated: 0, unchanged: 0, closed: 0 },
      'first sight of a closed item is not a closing',
    );
    assert.deepEqual(
      await ItemRepository.bulkUpsert(w, [
        jiraIssue('open', 'h2', { status: 'done', closedAt }),
        jiraIssue('progress', 'h2', { status: 'cancelled', closedAt }),
        jiraIssue('no-date', 'h2', { status: 'done' }),
        jiraIssue('was-done', 'h2', { status: 'done', closedAt, title: 'Renamed' }),
        jiraIssue('gone', 'h2', { status: 'done', closedAt, deletedAt: closedAt }),
      ]),
      { inserted: 0, updated: 5, unchanged: 0, closed: 2 },
    );
  });

  it('bulkUpsert restores a soft-deleted item it sees again, and cuts bodyPreview to 500', async () => {
    await ItemRepository.bulkUpsert('w-sync-2', [jiraIssue('9', 'sha1:nine')]);
    const id = await mirroredId('w-sync-2', '9');
    await ItemRepository.softDelete('w-sync-2', id);
    const longBody = `${'x'.repeat(499)}\u{1F600} and more`;
    const result = await ItemRepository.bulkUpsert('w-sync-2', [
      jiraIssue('9', 'sha1:nine', { bodyPreview: longBody }),
    ]);
    assert.deepEqual(result, { inserted: 0, updated: 1, unchanged: 0, closed: 0 });
    const item = await ItemRepository.findById('w-sync-2', id);
    assert.ok(item);
    assert.equal(item.deletedAt, null);
    assert.equal(item.bodyPreview, 'x'.repeat(499), 'never splits the emoji');
  });

  it('aggregate runs after the workspace $match and refuses stages that leave it', async () => {
    const rows = await ItemRepository.aggregate<{ workspaceId: string }>('w-sync', [
      { $project: { workspaceId: 1 } },
    ]);
    assert.equal(rows.length, 3);
    const unscoped: Record<string, unknown>[] = [
      { $lookup: { from: 'Items', localField: 'x', foreignField: 'y', as: 'z' } },
      { $unionWith: 'Items' },
      { $graphLookup: { from: 'Items' } },
      { $out: 'Stolen' },
      { $merge: { into: 'Stolen' } },
      { $facet: { all: [{ $unionWith: 'Items' }] } },
    ];
    for (const stage of unscoped) {
      await assert.rejects(ItemRepository.aggregate('w-sync', [stage]), /not allowed/);
    }
  });

  it('aggregate merges a leading $match, so $text search works and stays scoped', async () => {
    for (const workspaceId of ['w-text-a', 'w-text-b']) {
      await ItemRepository.createLocal(workspaceId, {
        ownerUserId: 'u-owner',
        title: 'Quarterly zebrafish report',
        topicId: 'work',
      });
    }
    await ItemRepository.createLocal('w-text-a', {
      ownerUserId: 'u-owner',
      title: 'Unrelated',
      topicId: 'work',
    });
    const rows = await ItemRepository.aggregate<{ workspaceId: string; title: string }>(
      'w-text-a',
      [{ $match: { $text: { $search: 'zebrafish' } } }, { $project: { workspaceId: 1, title: 1 } }],
    );
    assert.deepEqual(
      rows.map((row) => [row.workspaceId, row.title]),
      [['w-text-a', 'Quarterly zebrafish report']],
    );
    // Same value as the scope is fine; a different one is refused.
    const same = await ItemRepository.aggregate('w-text-a', [
      { $match: { workspaceId: 'w-text-a' } },
    ]);
    assert.equal(same.length, 2);
    await assert.rejects(
      ItemRepository.aggregate('w-text-a', [{ $match: { workspaceId: 'w-text-b' } }]),
      /workspaceId/,
    );
  });

  it('bodyPreview is cut to 500 characters, without throwing, in createLocal and updateLocal', async () => {
    const long = 'y'.repeat(600);
    const created = await ItemRepository.createLocal('w-preview', {
      ownerUserId: 'u-owner',
      title: 'Long',
      topicId: 'work',
      bodyPreview: long,
    });
    assert.equal(created.bodyPreview, 'y'.repeat(500));
    const updated = await ItemRepository.updateLocal('w-preview', created.id, {
      bodyPreview: 'z'.repeat(501),
    });
    assert.equal(updated?.bodyPreview, 'z'.repeat(500));
    const cleared = await ItemRepository.updateLocal('w-preview', created.id, {
      bodyPreview: null,
    });
    assert.equal(cleared?.bodyPreview, null);
    const untouched = await ItemRepository.updateLocal('w-preview', created.id, { title: 'T2' });
    assert.equal(untouched?.title, 'T2');
  });

  it('a source with accountId null is invalid; an empty accountId is fine', () => {
    const validate = (accountId: unknown): string | undefined =>
      new ItemMongoModel({
        workspaceId: 'w',
        kind: 'todo',
        topicId: 'work',
        title: 't',
        source: { provider: 'local', accountId, externalId: 'e', url: '/u' },
      }).validateSync()?.message;
    assert.match(validate(null) ?? '', /accountId/);
    assert.equal(validate(''), undefined);
  });
});

describe('ContainerRepository', () => {
  function course(
    externalId: string,
    hash: string,
    extra: Partial<ContainerUpsert> = {},
  ): ContainerUpsert {
    return {
      integrationId: 'i-moodle',
      topicId: 'college',
      type: 'course',
      name: `Course ${externalId}`,
      source: { ...jiraSource(externalId, hash), provider: 'moodle' },
      ...extra,
    };
  }

  it('bulkUpsert counts by hash and never touches hidden', async () => {
    assert.deepEqual(
      await ContainerRepository.bulkUpsert('w-cont', [course('c1', 'h1'), course('c2', 'h2')]),
      { inserted: 2, updated: 0, unchanged: 0 },
    );
    const [c1] = await ContainerRepository.list('w-cont', { type: 'course' });
    assert.ok(c1);
    await ContainerMongoModel.updateOne({ _id: c1.id }, { $set: { hidden: true } });
    assert.deepEqual(
      await ContainerRepository.bulkUpsert('w-cont', [
        course('c1', 'h1-v2', { name: 'Course c1 renamed' }),
        course('c2', 'h2'),
      ]),
      { inserted: 0, updated: 1, unchanged: 1 },
    );
    const renamed = await ContainerRepository.findById('w-cont', c1.id);
    assert.deepEqual([renamed?.name, renamed?.hidden], ['Course c1 renamed', true]);
  });

  it('bulkUpsert compares a stored hash of another algorithm field by field', async () => {
    await ContainerRepository.bulkUpsert('w-cont-rehash', [
      course('same', 'sha1:same', { path: ['Year 1'], props: { code: 'CS101' } }),
      course('renamed', 'sha1:renamed'),
    ]);
    const [same] = await ContainerRepository.list('w-cont-rehash', { externalIds: ['same'] });
    assert.ok(same);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      await ContainerRepository.bulkUpsert('w-cont-rehash', [
        course('same', 'sha256:same', { path: ['Year 1'], props: { code: 'CS101' } }),
        course('renamed', 'sha256:renamed', { name: 'Course renamed there' }),
      ]),
      { inserted: 0, updated: 1, unchanged: 1 },
    );
    const after = await ContainerRepository.findById('w-cont-rehash', same.id);
    assert.deepEqual([after?.source.hash, after?.updatedAt], ['sha256:same', same.updatedAt]);
    const [renamed] = await ContainerRepository.list('w-cont-rehash', { externalIds: ['renamed'] });
    assert.deepEqual(
      [renamed?.name, renamed?.source.hash],
      ['Course renamed there', 'sha256:renamed'],
    );
  });

  it('bulkUpsert reads an undefined in props as the old hash did, stored as null or not', async () => {
    const w = 'w-cont-rehash-undefined';
    const then = { props: { code: 'CS101', term: undefined, meta: { tag: undefined } } };
    const now = { props: { code: 'CS101', meta: {} } };
    assert.equal(
      containerSourceHash(course('u', 'sha1:u', then)),
      containerSourceHash(course('u', 'sha1:u', now)),
    );
    await ContainerRepository.bulkUpsert(w, [
      course('u', 'sha1:u', then),
      course('v', 'sha1:v', then),
    ]);
    const [stored] = await ContainerRepository.list(w, { externalIds: ['u'] });
    assert.ok(stored);
    await new Promise((resolve) => setTimeout(resolve, 20));
    assert.deepEqual(
      await ContainerRepository.bulkUpsert(w, [
        course('u', 'sha256:u', now),
        course('v', 'sha256:v', then),
      ]),
      { inserted: 0, updated: 0, unchanged: 2 },
    );
    const after = await ContainerRepository.findById(w, stored.id);
    assert.deepEqual([after?.source.hash, after?.updatedAt], ['sha256:u', stored.updatedAt]);
  });

  it('bulkUpsert stamps syncResource on every write, unchanged ones too', async () => {
    await ContainerRepository.bulkUpsert('w-cont-resource', [
      course('r1', 'h1', { syncResource: 'courses' }),
    ]);
    const [stored] = await ContainerRepository.list('w-cont-resource', {});
    assert.equal(stored?.syncResource, 'courses');
    const again = await ContainerRepository.bulkUpsert('w-cont-resource', [
      course('r1', 'h1', { syncResource: 'calendar' }),
    ]);
    assert.deepEqual(again, { inserted: 0, updated: 0, unchanged: 1 });
    const moved = await ContainerRepository.findById('w-cont-resource', stored.id);
    assert.deepEqual([moved?.syncResource, moved?.updatedAt], ['calendar', stored.updatedAt]);
  });

  it('list filters by type, topic and integration, and skips soft-deleted ones', async () => {
    await ContainerRepository.bulkUpsert('w-cont-2', [
      course('m1', 'h'),
      course('j1', 'h', { type: 'project', topicId: 'work', integrationId: 'i-jira' }),
      course('gone', 'h', { deletedAt: new Date() }),
    ]);
    const names = async (filter: ContainerFilter): Promise<string[]> =>
      (await ContainerRepository.list('w-cont-2', filter)).map((container) => container.name);
    assert.deepEqual(await names({}), ['Course j1', 'Course m1']);
    assert.deepEqual(await names({ type: 'course' }), ['Course m1']);
    assert.deepEqual(await names({ topicId: 'work', integrationId: 'i-jira' }), ['Course j1']);
    assert.deepEqual(await names({ externalIds: ['m1', 'gone', 'other'] }), ['Course m1']);
    assert.deepEqual(await names({ externalIds: [] }), []);
    const [count] = await ContainerRepository.aggregate<{ n: number }>('w-cont-2', [
      { $count: 'n' },
    ]);
    assert.equal(count?.n, 3);
  });

  it('softDeleteForWorkspace hides every container of that workspace only', async () => {
    await ContainerRepository.bulkUpsert('w-cont-workspace', [
      course('o1', 'h'),
      course('o2', 'h'),
    ]);
    await ContainerRepository.bulkUpsert('w-cont-kept', [course('k1', 'h')]);
    assert.equal(await ContainerRepository.softDeleteForWorkspace('w-cont-workspace'), 2);
    assert.deepEqual(await ContainerRepository.list('w-cont-workspace', {}), []);
    assert.equal(await ContainerMongoModel.countDocuments({ workspaceId: 'w-cont-workspace' }), 2);
    assert.equal((await ContainerRepository.list('w-cont-kept', {})).length, 1);
    assert.equal(await ContainerRepository.softDeleteForWorkspace('w-cont-workspace'), 0);
  });
});

describe('sweep and purge (Items, Containers)', () => {
  const cutoff = new Date('2026-11-12T08:00:00Z');
  const earlier = new Date('2026-11-12T07:00:00Z');
  const sweptAt = new Date('2026-11-12T09:00:00Z');
  const firstDeletion = new Date('2026-11-01T00:00:00Z');

  /** deletedAt of a mirrored item or container ('Items' | 'Containers'), read past the soft delete. */
  async function deletedAtOf(
    collection: 'Items' | 'Containers',
    workspaceId: string,
    externalId: string,
  ): Promise<Date | null | undefined> {
    const doc = await ItemMongoModel.db
      .collection(collection)
      .findOne({ workspaceId, 'source.externalId': externalId }, { projection: { deletedAt: 1 } });
    return doc?.['deletedAt'] as Date | null | undefined;
  }

  it("Item sweepUnseen soft-deletes this integration's live items of one resource seen before the cutoff", async () => {
    const w = 'w-sweep-items';
    const issue = (externalId: string, extra: Partial<ItemUpsert> = {}): ItemUpsert =>
      jiraIssue(externalId, 'h', { syncResource: 'issues', ...extra });
    await ItemRepository.bulkUpsert(w, [
      issue('seen'),
      issue('unseen'),
      issue('deleted-before'),
      issue('other-integration', { integrationId: 'i-other' }),
      issue('other-resource', { syncResource: 'boards' }),
      issue('no-resource', { syncResource: null }),
    ]);
    await ItemRepository.bulkUpsert('w-sweep-items-other', [issue('unseen')]);
    const local = await ItemRepository.createLocal(w, {
      ownerUserId: 'u-owner',
      title: 'Local',
      topicId: 'personal',
    });
    await ItemMongoModel.updateMany(
      { workspaceId: { $in: [w, 'w-sweep-items-other'] } },
      { $set: { lastSeenAt: earlier } },
    );
    // Seen exactly at the cutoff: kept (the sweep is strictly "before").
    await ItemMongoModel.updateOne(
      { workspaceId: w, 'source.externalId': 'seen' },
      { $set: { lastSeenAt: cutoff } },
    );
    await ItemMongoModel.updateOne(
      { workspaceId: w, 'source.externalId': 'deleted-before' },
      { $set: { deletedAt: firstDeletion } },
    );

    assert.equal(
      await ItemRepository.sweepUnseen(w, 'i-jira', 'issues', cutoff, { deletedAt: sweptAt }),
      1,
    );

    assert.deepEqual(await deletedAtOf('Items', w, 'unseen'), sweptAt);
    assert.equal(await deletedAtOf('Items', w, 'seen'), null);
    assert.deepEqual(
      await deletedAtOf('Items', w, 'deleted-before'),
      firstDeletion,
      'an earlier deletion keeps its date',
    );
    assert.equal(await deletedAtOf('Items', w, 'other-integration'), null);
    assert.equal(await deletedAtOf('Items', w, 'other-resource'), null);
    assert.equal(await deletedAtOf('Items', w, 'no-resource'), null);
    assert.equal(await deletedAtOf('Items', 'w-sweep-items-other', 'unseen'), null);
    assert.equal((await ItemRepository.findById(w, local.id))?.deletedAt, null);
  });

  it('Item sweepUnseen never sweeps the kept external ids', async () => {
    const w = 'w-sweep-keep';
    await ItemRepository.bulkUpsert(w, [
      jiraIssue('failed', 'h', { syncResource: 'issues' }),
      jiraIssue('gone', 'h', { syncResource: 'issues' }),
    ]);
    await ItemMongoModel.updateMany({ workspaceId: w }, { $set: { lastSeenAt: earlier } });
    const keep = { keepExternalIds: ['failed'], deletedAt: sweptAt };
    assert.equal(await ItemRepository.sweepUnseen(w, 'i-jira', 'issues', cutoff, keep), 1);
    assert.equal(await deletedAtOf('Items', w, 'failed'), null);
    assert.deepEqual(await deletedAtOf('Items', w, 'gone'), sweptAt);
  });

  it('Item sweepUnseen with a window sweeps only items whose window field is in [from, to)', async () => {
    const w = 'w-sweep-window';
    const from = new Date('2026-11-01T00:00:00Z');
    const to = new Date('2026-12-01T00:00:00Z');
    const at = (externalId: string, dueAt: Date | null): ItemUpsert =>
      jiraIssue(externalId, 'h', { syncResource: 'events', dueAt });
    await ItemRepository.bulkUpsert(w, [
      at('at-from', from),
      at('inside', new Date('2026-11-15T00:00:00Z')),
      at('before', new Date('2026-10-31T23:59:59Z')),
      at('at-to', to),
      at('undated', null),
    ]);
    await ItemMongoModel.updateMany({ workspaceId: w }, { $set: { lastSeenAt: earlier } });
    const window = { field: 'dueAt' as const, from, to };
    assert.equal(
      await ItemRepository.sweepUnseen(w, 'i-jira', 'events', cutoff, {
        window,
        deletedAt: sweptAt,
      }),
      2,
    );
    assert.deepEqual(await deletedAtOf('Items', w, 'at-from'), sweptAt);
    assert.deepEqual(await deletedAtOf('Items', w, 'inside'), sweptAt);
    for (const kept of ['before', 'at-to', 'undated']) {
      assert.equal(await deletedAtOf('Items', w, kept), null, kept);
    }
    // Only a time field may bound a sweep: never a scope key.
    const escape: unknown = { field: 'workspaceId', from: earlier, to: cutoff };
    await assert.rejects(
      ItemRepository.sweepUnseen(w, 'i-jira', 'events', cutoff, { window: escape as SweepWindow }),
      /cannot bound a sweep/,
    );
  });

  it("Container sweepUnseen soft-deletes this integration's live containers of one resource seen before the cutoff", async () => {
    const w = 'w-sweep-containers';
    const project = (
      externalId: string,
      integrationId = 'i-jira',
      syncResource = 'projects',
    ): ContainerUpsert => ({
      integrationId,
      topicId: 'work',
      type: 'project',
      name: `Project ${externalId}`,
      source: jiraSource(externalId, 'h'),
      syncResource,
    });
    await ContainerRepository.bulkUpsert(w, [
      project('seen'),
      project('unseen'),
      project('kept'),
      project('other', 'i-other'),
      project('other-resource', 'i-jira', 'boards'),
    ]);
    await ContainerRepository.bulkUpsert('w-sweep-containers-other', [project('unseen')]);
    await ContainerMongoModel.updateMany(
      { workspaceId: { $in: [w, 'w-sweep-containers-other'] } },
      { $set: { lastSeenAt: earlier } },
    );
    await ContainerMongoModel.updateOne(
      { workspaceId: w, 'source.externalId': 'seen' },
      { $set: { lastSeenAt: cutoff } },
    );

    const options = { deletedAt: sweptAt, keepExternalIds: ['kept'] };
    assert.equal(
      await ContainerRepository.sweepUnseen(w, 'i-jira', 'projects', cutoff, options),
      1,
    );
    assert.equal(
      await ContainerRepository.sweepUnseen(w, 'i-jira', 'projects', cutoff, options),
      0,
    );

    assert.deepEqual(await deletedAtOf('Containers', w, 'unseen'), sweptAt);
    for (const kept of ['seen', 'kept', 'other', 'other-resource']) {
      assert.equal(await deletedAtOf('Containers', w, kept), null, kept);
    }
    assert.equal(await deletedAtOf('Containers', 'w-sweep-containers-other', 'unseen'), null);
  });

  it("sweepOrphanedResources deletes this integration's live records of resources no longer listed", async () => {
    const w = 'w-orphans';
    const issue = (externalId: string, extra: Partial<ItemUpsert> = {}): ItemUpsert =>
      jiraIssue(externalId, 'h', { syncResource: 'removed', ...extra });
    await ItemRepository.bulkUpsert(w, [
      issue('orphan'),
      issue('listed', { syncResource: 'issues' }),
      issue('kept'),
      issue('no-resource', { syncResource: null }),
      issue('deleted-before'),
      issue('other-integration', { integrationId: 'i-other' }),
    ]);
    await ItemRepository.bulkUpsert('w-orphans-other', [issue('orphan')]);
    await ItemMongoModel.updateOne(
      { workspaceId: w, 'source.externalId': 'deleted-before' },
      { $set: { deletedAt: firstDeletion } },
    );
    const local = await ItemRepository.createLocal(w, {
      ownerUserId: 'u-owner',
      title: 'Local',
      topicId: 'personal',
    });
    await ContainerRepository.bulkUpsert(w, [
      {
        integrationId: 'i-jira',
        topicId: 'work',
        type: 'project',
        name: 'Removed project',
        source: jiraSource('p-orphan', 'h'),
        syncResource: 'removed-projects',
      },
      {
        integrationId: 'i-jira',
        topicId: 'work',
        type: 'project',
        name: 'Listed project',
        source: jiraSource('p-listed', 'h'),
        syncResource: 'projects',
      },
    ]);

    const options = { deletedAt: sweptAt, keepExternalIds: ['kept'] };
    const listed = ['issues', 'projects'];
    assert.equal(await ItemRepository.sweepOrphanedResources(w, 'i-jira', listed, options), 1);
    assert.equal(await ContainerRepository.sweepOrphanedResources(w, 'i-jira', listed, options), 1);

    assert.deepEqual(await deletedAtOf('Items', w, 'orphan'), sweptAt);
    for (const live of ['listed', 'kept', 'no-resource', 'other-integration']) {
      assert.equal(await deletedAtOf('Items', w, live), null, live);
    }
    assert.deepEqual(await deletedAtOf('Items', w, 'deleted-before'), firstDeletion);
    assert.equal(await deletedAtOf('Items', 'w-orphans-other', 'orphan'), null);
    assert.equal((await ItemRepository.findById(w, local.id))?.deletedAt, null);
    assert.deepEqual(await deletedAtOf('Containers', w, 'p-orphan'), sweptAt);
    assert.equal(await deletedAtOf('Containers', w, 'p-listed'), null);
  });

  it('sweepUnseen defaults deletedAt to now', async () => {
    await ItemRepository.bulkUpsert('w-sweep-now', [
      jiraIssue('x', 'h', { syncResource: 'issues' }),
    ]);
    await ItemMongoModel.updateOne(
      { workspaceId: 'w-sweep-now' },
      { $set: { lastSeenAt: earlier } },
    );
    const before = Date.now();
    assert.equal(await ItemRepository.sweepUnseen('w-sweep-now', 'i-jira', 'issues', cutoff), 1);
    const deletedAt = await deletedAtOf('Items', 'w-sweep-now', 'x');
    assert.ok(deletedAt instanceof Date && deletedAt.getTime() >= before);
  });

  it("softDeleteForIntegration soft-deletes this integration's live items and containers only", async () => {
    const w = 'w-disconnect';
    await ItemRepository.bulkUpsert(w, [
      jiraIssue('live', 'h'),
      jiraIssue('deleted-before', 'h'),
      jiraIssue('other', 'h', { integrationId: 'i-other' }),
    ]);
    await ItemRepository.bulkUpsert('w-disconnect-other', [jiraIssue('live', 'h')]);
    await ItemMongoModel.updateOne(
      { workspaceId: w, 'source.externalId': 'deleted-before' },
      { $set: { deletedAt: firstDeletion } },
    );
    const local = await ItemRepository.createLocal(w, {
      ownerUserId: 'u-owner',
      title: 'Local',
      topicId: 'personal',
    });
    await ContainerRepository.bulkUpsert(w, [
      {
        integrationId: 'i-jira',
        topicId: 'work',
        type: 'project',
        name: 'Project',
        source: jiraSource('project', 'h'),
      },
    ]);

    assert.equal(await ItemRepository.softDeleteForIntegration(w, 'i-jira', sweptAt), 1);
    assert.equal(await ContainerRepository.softDeleteForIntegration(w, 'i-jira', sweptAt), 1);
    assert.equal(await ItemRepository.softDeleteForIntegration(w, 'i-jira', sweptAt), 0);

    assert.deepEqual(await deletedAtOf('Items', w, 'live'), sweptAt);
    assert.deepEqual(await deletedAtOf('Items', w, 'deleted-before'), firstDeletion);
    assert.equal(await deletedAtOf('Items', w, 'other'), null);
    assert.equal(await deletedAtOf('Items', 'w-disconnect-other', 'live'), null);
    assert.equal((await ItemRepository.findById(w, local.id))?.deletedAt, null);
    assert.deepEqual(await deletedAtOf('Containers', w, 'project'), sweptAt);
  });

  it('purgeDeletedBefore hard-deletes rows soft-deleted before the date, in every workspace', async () => {
    // Far in the past, so nothing another test soft-deleted (at "now") is in range.
    const purgeBefore = new Date('2000-01-01T00:00:00Z');
    const old = new Date('1999-12-01T00:00:00Z');
    const recent = new Date('2000-01-02T00:00:00Z');
    for (const w of ['w-purge-a', 'w-purge-b']) {
      await ItemRepository.bulkUpsert(w, [
        jiraIssue('old', 'h'),
        jiraIssue('recent', 'h'),
        jiraIssue('live', 'h'),
      ]);
      await ContainerRepository.bulkUpsert(w, [
        {
          integrationId: 'i-jira',
          topicId: 'work',
          type: 'project',
          name: 'Old',
          source: jiraSource('old', 'h'),
        },
        {
          integrationId: 'i-jira',
          topicId: 'work',
          type: 'project',
          name: 'Live',
          source: jiraSource('live', 'h'),
        },
      ]);
      const oldOne = { workspaceId: w, 'source.externalId': 'old' };
      await ItemMongoModel.updateOne(oldOne, { $set: { deletedAt: old } });
      await ContainerMongoModel.updateOne(oldOne, { $set: { deletedAt: old } });
      await ItemMongoModel.updateOne(
        { workspaceId: w, 'source.externalId': 'recent' },
        { $set: { deletedAt: recent } },
      );
    }

    assert.equal(await ItemRepository.purgeDeletedBefore(purgeBefore), 2);
    assert.equal(await ContainerRepository.purgeDeletedBefore(purgeBefore), 2);
    assert.equal(await ItemRepository.purgeDeletedBefore(purgeBefore), 0);

    for (const w of ['w-purge-a', 'w-purge-b']) {
      const items = await ItemMongoModel.find({ workspaceId: w }).lean<{ source: SourceRef }[]>();
      assert.deepEqual(items.map((item) => item.source.externalId).sort(), ['live', 'recent']);
      const containers = await ContainerMongoModel.find({ workspaceId: w }).lean<
        { source: SourceRef }[]
      >();
      assert.deepEqual(
        containers.map((container) => container.source.externalId),
        ['live'],
      );
    }
  });
});

describe('delete signals (Items, Containers)', () => {
  const firstDeletion = new Date('2026-11-01T00:00:00Z');
  const later = new Date('2026-11-12T09:00:00Z');
  const account = {
    provider: 'jira' as const,
    accountId: 'site.example.invalid',
    integrationId: 'i-jira',
  };

  /** A stored document of the account, soft-deleted or not, by external id. */
  async function stored(
    collection: 'Items' | 'Containers',
    workspaceId: string,
    externalId: string,
  ): Promise<Record<string, unknown> | null> {
    return ItemMongoModel.db.collection(collection).findOne({
      workspaceId,
      'source.accountId': account.accountId,
      'source.externalId': externalId,
    });
  }

  function project(externalId: string, extra: Partial<ContainerUpsert> = {}): ContainerUpsert {
    return {
      integrationId: 'i-jira',
      topicId: 'work',
      type: 'project',
      name: `Project ${externalId}`,
      source: jiraSource(externalId, 'h'),
      ...extra,
    };
  }

  it('bulkUpsert: a delete signalled again for a copy already deleted is unchanged, its deletedAt kept', async () => {
    const w = 'w-deleted-again';
    await ItemRepository.bulkUpsert(w, [jiraIssue('gone', 'h1')]);
    const signal = (deletedAt: Date): ItemUpsert => jiraIssue('gone', 'h1', { deletedAt });
    assert.deepEqual(await ItemRepository.bulkUpsert(w, [signal(firstDeletion)]), {
      inserted: 0,
      updated: 1,
      unchanged: 0,
      closed: 0,
    });
    assert.deepEqual(await ItemRepository.bulkUpsert(w, [signal(later)]), {
      inserted: 0,
      updated: 0,
      unchanged: 1,
      closed: 0,
    });
    assert.deepEqual((await stored('Items', w, 'gone'))?.['deletedAt'], firstDeletion);

    await ContainerRepository.bulkUpsert(w, [project('p-gone', { deletedAt: firstDeletion })]);
    assert.deepEqual(
      await ContainerRepository.bulkUpsert(w, [project('p-gone', { deletedAt: later })]),
      { inserted: 0, updated: 0, unchanged: 1 },
    );
    assert.deepEqual((await stored('Containers', w, 'p-gone'))?.['deletedAt'], firstDeletion);
  });

  it('softDeleteBySource deletes the live copies by id and changes nothing else', async () => {
    const w = 'w-delete-only';
    const dueAt = new Date('2026-11-15T21:59:00Z');
    await ItemRepository.bulkUpsert(w, [
      jiraIssue('live', 'h', { dueAt, props: { sprint: 'S45' }, syncResource: 'issues' }),
      jiraIssue('already', 'h'),
      jiraIssue('other-account', 'h', {
        source: { ...jiraSource('live', 'h'), accountId: 'other.example.invalid' },
      }),
    ]);
    await ItemRepository.bulkUpsert('w-delete-only-other', [jiraIssue('live', 'h')]);
    await ItemMongoModel.updateOne(
      { workspaceId: w, 'source.externalId': 'already' },
      { $set: { deletedAt: firstDeletion } },
    );
    const before = await stored('Items', w, 'live');
    assert.ok(before);

    assert.deepEqual(
      await ItemRepository.softDeleteBySource(
        w,
        account,
        ['live', 'already', 'unknown', 'live'],
        later,
      ),
      { deleted: 1, alreadyDeleted: 1 },
    );

    const after = await stored('Items', w, 'live');
    const { deletedAt, updatedAt, ...rest } = after ?? {};
    assert.deepEqual(deletedAt, later);
    assert.ok(updatedAt instanceof Date && updatedAt >= (before['updatedAt'] as Date));
    assert.deepEqual(
      rest,
      Object.fromEntries(
        Object.entries(before).filter(([key]) => key !== 'deletedAt' && key !== 'updatedAt'),
      ),
      'title, dates, props, source, lastSeenAt and syncResource are untouched',
    );
    assert.deepEqual((await stored('Items', w, 'already'))?.['deletedAt'], firstDeletion);
    assert.equal(await stored('Items', w, 'unknown'), null, 'an unknown id is ignored');
    const otherAccount = await ItemMongoModel.db
      .collection('Items')
      .findOne({ workspaceId: w, 'source.accountId': 'other.example.invalid' });
    assert.equal(otherAccount?.['deletedAt'], null);
    assert.equal((await stored('Items', 'w-delete-only-other', 'live'))?.['deletedAt'], null);
    assert.deepEqual(await ItemRepository.softDeleteBySource(w, account, [], later), {
      deleted: 0,
      alreadyDeleted: 0,
    });
  });

  it('softDeleteBySource on containers: the same rules', async () => {
    const w = 'w-delete-only-containers';
    await ContainerRepository.bulkUpsert(w, [project('p-live'), project('p-already')]);
    await ContainerMongoModel.updateOne(
      { workspaceId: w, 'source.externalId': 'p-already' },
      { $set: { deletedAt: firstDeletion } },
    );
    assert.deepEqual(
      await ContainerRepository.softDeleteBySource(
        w,
        account,
        ['p-live', 'p-already', 'p-unknown'],
        later,
      ),
      { deleted: 1, alreadyDeleted: 1 },
    );
    const live = await stored('Containers', w, 'p-live');
    assert.deepEqual([live?.['deletedAt'], live?.['name']], [later, 'Project p-live']);
    assert.deepEqual((await stored('Containers', w, 'p-already'))?.['deletedAt'], firstDeletion);
  });
});

describe('SyncStateRepository and SyncRunRepository', () => {
  it('upsert creates the state, then changes only the fields given', async () => {
    assert.equal(await SyncStateRepository.get('w-sync-state', 'i-1', 'jira:jql'), null);
    const created = await SyncStateRepository.upsert('w-sync-state', 'i-1', 'jira:jql', {
      cursor: 'c-1',
    });
    assert.deepEqual(
      [created.cursor, created.consecutiveErrors, created.syncToken],
      ['c-1', 0, null],
    );
    const updated = await SyncStateRepository.upsert('w-sync-state', 'i-1', 'jira:jql', {
      consecutiveErrors: 2,
    });
    assert.deepEqual(
      [updated.id, updated.cursor, updated.consecutiveErrors],
      [created.id, 'c-1', 2],
    );
    assert.equal(
      (await SyncStateRepository.get('w-sync-state', 'i-1', 'jira:jql'))?.id,
      created.id,
    );
  });

  it('runs start queued with a 30-day expiry and list newest first', async () => {
    const run = await SyncRunRepository.create('w-runs', {
      integrationId: 'i-1',
      trigger: 'manual',
    });
    assert.deepEqual(
      [run.status, run.counts, run.error, run.finishedAt],
      ['queued', {}, null, null],
    );
    const days = (run.expireAt.getTime() - run.startedAt.getTime()) / DAY;
    assert.ok(days > 29.9 && days < 30.1, String(days));
    const finished = await SyncRunRepository.update('w-runs', run.id, {
      status: 'failed',
      finishedAt: new Date(),
      counts: { fetched: 3 },
      error: { code: 'HTTP_429', message: 'rate limited' },
    });
    assert.deepEqual(
      [finished?.status, finished?.counts, finished?.error],
      ['failed', { fetched: 3 }, { code: 'HTTP_429', message: 'rate limited' }],
    );
    const later = await SyncRunRepository.create('w-runs', {
      integrationId: 'i-1',
      trigger: 'schedule',
      startedAt: new Date(Date.now() + 1000),
    });
    const listed = await SyncRunRepository.listForIntegration('w-runs', 'i-1', 1);
    assert.deepEqual(
      listed.map((r) => r.id),
      [later.id],
    );
  });

  it('countFailedRun counts a run once: the increment and its run id are one write', async () => {
    const w = 'w-runs-counted';
    const count = (runId: string): Promise<number | null> =>
      SyncStateRepository.countFailedRun(w, 'i-counted', '__run__', runId);
    // The first count creates the state.
    assert.equal(await count('run-1'), 1);
    assert.equal(await count('run-1'), null, 'a retry of the same run');
    assert.equal(await count('run-2'), 2);
    // A success resets the count; the runs already counted stay counted.
    await SyncStateRepository.upsert(w, 'i-counted', '__run__', { consecutiveErrors: 0 });
    assert.equal(await count('run-2'), null);
    assert.equal(await count('run-3'), 1);
    const state = await SyncStateRepository.get(w, 'i-counted', '__run__');
    assert.equal(state?.consecutiveErrors, 1);
  });

  it('countFailedRun is atomic: concurrent deliveries count once, concurrent runs all count', async () => {
    const w = 'w-runs-counted-race';
    const count = (runId: string): Promise<number | null> =>
      SyncStateRepository.countFailedRun(w, 'i-race', '__run__', runId);
    const same = await Promise.all([count('run-a'), count('run-a'), count('run-a')]);
    assert.deepEqual(
      same.filter((result) => result !== null),
      [1],
    );
    const runs = Array.from({ length: 8 }, (_, index) => `run-${String(index)}`);
    const results = await Promise.all(runs.map(count));
    assert.deepEqual(
      [...results].sort((a, b) => (a ?? 0) - (b ?? 0)),
      [2, 3, 4, 5, 6, 7, 8, 9],
    );
    assert.equal(
      (await SyncStateRepository.get(w, 'i-race', '__run__'))?.consecutiveErrors,
      9,
      'no increment lost',
    );
  });

  it('countFailedRun remembers the latest runs only', async () => {
    const w = 'w-runs-counted-kept';
    const count = (runId: string): Promise<number | null> =>
      SyncStateRepository.countFailedRun(w, 'i-kept', '__run__', runId);
    for (let index = 0; index < 25; index += 1) await count(`run-${String(index)}`);
    const doc = await ItemMongoModel.db
      .collection('SyncStates')
      .findOne({ workspaceId: w, integrationId: 'i-kept' });
    const kept = doc?.['countedRunIds'] as string[] | undefined;
    assert.equal(kept?.length, 20);
    assert.equal(kept[0], 'run-5');
    assert.equal(await count('run-24'), null);
  });

  it('updateIfStatus ends a run only while it has one of the given statuses', async () => {
    const w = 'w-runs-conditional';
    const run = await SyncRunRepository.create(w, {
      integrationId: 'i-1',
      trigger: 'schedule',
      status: 'running',
    });
    const timedOut = {
      status: 'failed' as const,
      finishedAt: new Date('2026-11-12T08:00:00Z'),
      error: { code: 'timeout', message: 'The sync did not finish in time' },
    };
    assert.equal(
      await SyncRunRepository.updateIfStatus('w-other', run.id, ['running'], timedOut),
      null,
    );
    assert.equal(await SyncRunRepository.updateIfStatus(w, run.id, ['queued'], timedOut), null);
    const ended = await SyncRunRepository.updateIfStatus(
      w,
      run.id,
      ['queued', 'running'],
      timedOut,
    );
    assert.deepEqual([ended?.status, ended?.error?.code], ['failed', 'timeout']);
    assert.equal(
      await SyncRunRepository.updateIfStatus(w, run.id, ['running'], { status: 'succeeded' }),
      null,
      'finished: left as it is',
    );
  });

  it('listRunningStartedBefore: running runs that started before the date, every workspace, oldest first', async () => {
    const before = new Date('2001-01-01T00:15:00Z');
    const at = (minutes: number): Date => new Date(Date.UTC(2001, 0, 1, 0, minutes));
    const make = (
      workspaceId: string,
      minutes: number,
      status: 'running' | 'queued' | 'partial',
    ): Promise<SyncRunData> =>
      SyncRunRepository.create(workspaceId, {
        integrationId: `i-${workspaceId}`,
        trigger: 'schedule',
        status,
        startedAt: at(minutes),
      });
    const second = await make('w-stale-a', 5, 'running');
    const first = await make('w-stale-b', 1, 'running');
    await make('w-stale-a', 15, 'running'); // at the cutoff: not before it
    await make('w-stale-a', 2, 'queued');
    await make('w-stale-a', 3, 'partial');
    const stale = await SyncRunRepository.listRunningStartedBefore(before, 10);
    assert.deepEqual(
      stale.map((run) => run.id),
      [first.id, second.id],
    );
    assert.deepEqual(
      (await SyncRunRepository.listRunningStartedBefore(before, 1)).map((run) => run.id),
      [first.id],
    );
  });

  it('a run starts without failures and records the records a sync skipped', async () => {
    const run = await SyncRunRepository.create('w-runs-failures', {
      integrationId: 'i-1',
      trigger: 'manual',
      status: 'running',
    });
    assert.deepEqual(run.failures, []);
    const failures = [
      { externalId: 'E', code: 'missing_url' },
      { externalId: '', code: 'missing_id' },
    ];
    const finished = await SyncRunRepository.update('w-runs-failures', run.id, {
      status: 'partial',
      failures,
    });
    assert.deepEqual(finished?.failures, failures);
    assert.deepEqual(
      (await SyncRunRepository.findById('w-runs-failures', run.id))?.failures,
      failures,
    );
  });
});

describe('AuditLogRepository', () => {
  it('appends entries and lists them newest first, filtered by agent, action and time', async () => {
    const start = new Date(Date.now() - DAY);
    await AuditLogRepository.append('w-audit', {
      actorUserId: 'u-1',
      action: 'member.invite',
      at: new Date(start.getTime() - 1000),
    });
    const ui = await AuditLogRepository.append('w-audit', {
      actorUserId: 'u-1',
      action: 'member.invite',
    });
    assert.deepEqual([ui.actorAgentId, ui.meta, ui.ip], [null, {}, null]);
    const agent = await AuditLogRepository.append('w-audit', {
      actorUserId: 'u-1',
      actorAgentId: 'k-1',
      action: 'mcp.create_todo',
      meta: { argsHash: 'sha256:x', resultStatus: 'ok' },
    });
    const all = await AuditLogRepository.list('w-audit', {}, 10);
    assert.equal(all.length, 3);
    assert.equal(all[0]?.id, agent.id);
    assert.deepEqual(
      (await AuditLogRepository.list('w-audit', { actorAgentId: 'k-1' }, 10)).map((e) => e.id),
      [agent.id],
    );
    assert.deepEqual(
      (await AuditLogRepository.list('w-audit', { action: 'member.invite', since: start }, 10)).map(
        (e) => e.id,
      ),
      [ui.id],
    );
  });

  it('pages newest first with a stable order: same-time entries by id, then strictly before', async () => {
    const at = new Date('2026-11-01T10:00:00.000Z');
    const ids: string[] = [];
    for (let i = 0; i < 3; i += 1) {
      ids.push(
        (await AuditLogRepository.append('w-page', { actorUserId: 'u', action: 'a', at })).id,
      );
    }
    const older = await AuditLogRepository.append('w-page', {
      actorUserId: 'u',
      action: 'a',
      at: new Date(at.getTime() - 1000),
    });
    const sameTime = [...ids].sort().reverse();
    const first = await AuditLogRepository.list('w-page', {}, 2);
    assert.deepEqual(
      first.map((entry) => entry.id),
      sameTime.slice(0, 2),
    );
    const last = first[1];
    assert.ok(last);
    const second = await AuditLogRepository.list(
      'w-page',
      { before: { at: last.at, id: last.id } },
      10,
    );
    assert.deepEqual(
      second.map((entry) => entry.id),
      [sameTime[2], older.id],
    );
  });

  it('findRecent returns the newest match on action, agent and meta values', async () => {
    const since = new Date(Date.now() - 1000);
    const query = {
      action: 'mcp.create_todo',
      actorAgentId: 'k-2',
      metaEquals: { idempotencyKey: 'abc' },
      since,
    };
    assert.equal(await AuditLogRepository.findRecent('w-recent', query), null);
    await AuditLogRepository.append('w-recent', {
      actorUserId: 'u-1',
      actorAgentId: 'k-2',
      action: 'mcp.create_todo',
      meta: { idempotencyKey: 'abc', resultStatus: 'first' },
    });
    const newest = await AuditLogRepository.append('w-recent', {
      actorUserId: 'u-1',
      actorAgentId: 'k-2',
      action: 'mcp.create_todo',
      meta: { idempotencyKey: 'abc', resultStatus: 'second' },
      at: new Date(Date.now() + 1000),
    });
    await AuditLogRepository.append('w-recent', {
      actorUserId: 'u-1',
      actorAgentId: 'k-2',
      action: 'mcp.create_todo',
      meta: { idempotencyKey: 'other' },
      at: new Date(Date.now() + 2000),
    });
    assert.equal((await AuditLogRepository.findRecent('w-recent', query))?.id, newest.id);
    await assert.rejects(
      AuditLogRepository.findRecent('w-recent', { ...query, metaEquals: { $where: 'x' } }),
      /metaEquals/,
    );
  });
});

describe('DashboardRepository and DashboardVersionRepository', () => {
  it('replaceIfVersion returns null on a stale version and bumps the version on success', async () => {
    const dashboard = await DashboardRepository.create('w-dash', {
      ownerUserId: 'u-1',
      title: 'Main',
    });
    assert.deepEqual(
      [dashboard.version, dashboard.scope, dashboard.layouts, dashboard.published],
      [
        1,
        { topicId: null, containerId: null, page: 'topic', groupVar: null },
        { lg: [], md: [], sm: [] },
        null,
      ],
    );
    const next = await DashboardRepository.replaceIfVersion('w-dash', dashboard.id, 1, {
      title: 'Main v2',
      blocks: [{ id: 'blk_1', type: 'list' }],
      updatedBy: { userId: null, agentId: 'k-1' },
    });
    assert.ok(next);
    assert.deepEqual(
      [next.version, next.title, next.blocks, next.updatedBy],
      [2, 'Main v2', [{ id: 'blk_1', type: 'list' }], { userId: null, agentId: 'k-1' }],
    );
    assert.equal(
      await DashboardRepository.replaceIfVersion('w-dash', dashboard.id, 1, { title: 'Stale' }),
      null,
    );
    const stored = await DashboardRepository.findById('w-dash', dashboard.id);
    assert.deepEqual([stored?.version, stored?.title], [2, 'Main v2']);

    const published = await DashboardRepository.replaceIfVersion('w-dash', dashboard.id, 2, {
      publishedVersion: 3,
      published: { title: 'Main v2', vars: {}, layouts: { lg: [], md: [], sm: [] }, blocks: [] },
    });
    assert.deepEqual([published?.version, published?.publishedVersion], [3, 3]);
  });

  it('lists by topic (null = main dashboard) and page, without deleted ones', async () => {
    await DashboardRepository.create('w-dash-list', { ownerUserId: 'u-1', title: 'Main' });
    await DashboardRepository.create('w-dash-list', {
      ownerUserId: 'u-1',
      title: 'College',
      scope: { topicId: 'college' },
    });
    const group = await DashboardRepository.create('w-dash-list', {
      ownerUserId: 'u-1',
      title: 'Course page',
      scope: { topicId: 'college', containerId: 'ct-1', page: 'group' },
    });
    const titles = async (
      filter: Parameters<typeof DashboardRepository.list>[1],
    ): Promise<string[]> =>
      (await DashboardRepository.list('w-dash-list', filter)).map((d) => d.title);
    assert.deepEqual(await titles({ topicId: null }), ['Main']);
    assert.deepEqual(await titles({ topicId: 'college', page: 'topic' }), ['College']);
    assert.equal(await DashboardRepository.softDelete('w-dash-list', group.id), true);
    assert.deepEqual(await titles({ topicId: 'college' }), ['College']);
    assert.equal(await DashboardRepository.replaceIfVersion('w-dash-list', group.id, 1, {}), null);
  });

  it('replaceIfVersion refuses a version that is not an integer', async () => {
    const dashboard = await DashboardRepository.create('w-dash-int', {
      ownerUserId: 'u-1',
      title: 'Int',
      scope: { topicId: 'work' },
    });
    for (const bad of [1.5, Number.NaN, Number.POSITIVE_INFINITY, '1' as unknown as number]) {
      await assert.rejects(
        DashboardRepository.replaceIfVersion('w-dash-int', dashboard.id, bad, {}),
        TypeError,
      );
    }
    const ok = await DashboardRepository.replaceIfVersion('w-dash-int', dashboard.id, 1, {
      title: 'Int 2',
    });
    assert.equal(ok?.version, 2);
  });

  it('versions: append, list newest first, find one, and prune keeping latest and pinned ones', async () => {
    for (let version = 1; version <= 6; version += 1) {
      await DashboardVersionRepository.append('w-dash', {
        dashboardId: 'd-hist',
        version,
        patch: [{ op: 'replace', path: '/title', value: `v${String(version)}` }],
        inverse: [],
        actorUserId: 'u-1',
      });
    }
    await assert.rejects(
      DashboardVersionRepository.append('w-dash', {
        dashboardId: 'd-hist',
        version: 6,
        patch: [],
        inverse: [],
        actorUserId: 'u-1',
      }),
      (error: unknown) => (error as { code?: unknown }).code === 11000,
    );
    const versions = (list: { version: number }[]): number[] => list.map((v) => v.version);
    assert.deepEqual(
      versions(await DashboardVersionRepository.list('w-dash', 'd-hist', 3)),
      [6, 5, 4],
    );
    const second = await DashboardVersionRepository.findByVersion('w-dash', 'd-hist', 2);
    assert.deepEqual([second?.snapshot, second?.summary, second?.actorAgentId], [null, null, null]);

    assert.equal(await DashboardVersionRepository.pruneKeeping('w-dash', 'd-hist', 2, [1]), 3);
    assert.deepEqual(
      versions(await DashboardVersionRepository.list('w-dash', 'd-hist', 10)),
      [6, 5, 1],
    );
    assert.equal(await DashboardVersionRepository.pruneKeeping('w-dash', 'd-hist', 0, [5]), 2);
    assert.deepEqual(versions(await DashboardVersionRepository.list('w-dash', 'd-hist', 10)), [5]);
  });

  it('pruneKeeping never deletes a version appended after it read the latest ones', async () => {
    for (let version = 1; version <= 4; version += 1) {
      await DashboardVersionRepository.append('w-dash-race', {
        dashboardId: 'd-race',
        version,
        patch: [],
        inverse: [],
        actorUserId: 'u-1',
      });
    }
    // The race: a new version lands between the read of the latest ones and the delete.
    const realDelete = DashboardVersionMongoModel.deleteMany.bind(DashboardVersionMongoModel);
    const spy = mock.method(DashboardVersionMongoModel, 'deleteMany', async (filter: object) => {
      spy.mock.restore();
      await DashboardVersionRepository.append('w-dash-race', {
        dashboardId: 'd-race',
        version: 5,
        patch: [],
        inverse: [],
        actorUserId: 'u-1',
      });
      return realDelete(filter);
    });
    assert.equal(await DashboardVersionRepository.pruneKeeping('w-dash-race', 'd-race', 2, [1]), 1);
    const left = (await DashboardVersionRepository.list('w-dash-race', 'd-race', 10)).map(
      (v) => v.version,
    );
    assert.deepEqual(left, [5, 4, 3, 1]);
  });
});

describe('ViewRepository', () => {
  it('creates, lists by title, updates and deletes views', async () => {
    const b = await ViewRepository.create('w-views', {
      ownerUserId: 'u-1',
      title: 'B view',
      query: { source: 'items' },
      viz: { kind: 'table' },
    });
    await ViewRepository.create('w-views', {
      ownerUserId: 'u-1',
      title: 'A view',
      query: {},
      viz: {},
    });
    assert.deepEqual(
      (await ViewRepository.list('w-views')).map((v) => v.title),
      ['A view', 'B view'],
    );
    const updated = await ViewRepository.update('w-views', b.id, { visibility: 'private' });
    assert.deepEqual([updated?.visibility, updated?.query], ['private', { source: 'items' }]);
    assert.equal(await ViewRepository.delete('w-views', b.id), true);
    assert.equal(await ViewRepository.findById('w-views', b.id), null);
    assert.equal(await ViewRepository.delete('w-views', b.id), false);
  });
});

describe('AgentKeyRepository', () => {
  it('finds a key by hash without ever returning the hash', async () => {
    const key = await AgentKeyRepository.create('w-keys', {
      userId: 'u-1',
      name: 'Remi',
      keyHash: 'sha256-of-a-FAKE-key',
      prefix: 'elk_FAKE',
      scopes: ['read', 'builder:write'],
    });
    assert.ok(!('keyHash' in key));
    const found = await AgentKeyRepository.findByHash('sha256-of-a-FAKE-key');
    assert.deepEqual([found?.id, found?.scopes], [key.id, ['read', 'builder:write']]);
    assert.ok(found && !('keyHash' in found));
    assert.equal(await AgentKeyRepository.findByHash('unknown-hash'), null);
  });

  it('touch records use without bumping updatedAt; revoked keys leave the list and the count', async () => {
    const key = await AgentKeyRepository.create('w-keys-2', {
      userId: 'u-1',
      name: 'CI',
      keyHash: 'hash-FAKE-2',
      prefix: 'elk_FAKE',
      scopes: ['read'],
    });
    const usedAt = new Date(Date.now() + 5000);
    await AgentKeyRepository.touch('w-keys-2', key.id, usedAt);
    const raw = await AgentKeyMongoModel.findById(key.id).lean();
    assert.deepEqual([raw?.lastUsedAt, raw?.updatedAt], [usedAt, key.updatedAt]);
    assert.equal(await AgentKeyRepository.countForUser('w-keys-2', 'u-1'), 1);
    assert.equal(await AgentKeyRepository.revoke('w-keys-2', key.id), true);
    assert.equal(await AgentKeyRepository.revoke('w-keys-2', key.id), false);
    assert.deepEqual(await AgentKeyRepository.listForUser('w-keys-2', 'u-1'), []);
    assert.equal(await AgentKeyRepository.countForUser('w-keys-2', 'u-1'), 0);
    assert.ok((await AgentKeyRepository.findByHash('hash-FAKE-2'))?.revokedAt instanceof Date);
  });

  it('revokeForUser revokes every key of that user in that workspace only', async () => {
    const key = async (workspaceId: string, userId: string, hash: string): Promise<void> => {
      await AgentKeyRepository.create(workspaceId, {
        userId,
        name: hash,
        keyHash: hash,
        prefix: 'elk_FAKE',
        scopes: ['read'],
      });
    };
    await key('w-keys-3', 'u-leaving', 'hash-FAKE-3a');
    await key('w-keys-3', 'u-leaving', 'hash-FAKE-3b');
    await key('w-keys-3', 'u-staying', 'hash-FAKE-3c');
    await key('w-keys-4', 'u-leaving', 'hash-FAKE-3d');
    assert.equal(await AgentKeyRepository.revokeForUser('w-keys-3', 'u-leaving'), 2);
    assert.equal(await AgentKeyRepository.countForUser('w-keys-3', 'u-leaving'), 0);
    assert.equal(await AgentKeyRepository.countForUser('w-keys-3', 'u-staying'), 1);
    assert.equal(await AgentKeyRepository.countForUser('w-keys-4', 'u-leaving'), 1);
    assert.equal(await AgentKeyRepository.revokeForUser('w-keys-3', 'u-leaving'), 0);
  });
});

describe('CalendarLinkRepository', () => {
  it('upserts by item, finds by item, and tombstones once', async () => {
    const key = { calendarId: 'primary', googleEventId: 'el0001' };
    const link = await CalendarLinkRepository.upsert('w-cal', 'i-gcal', key, {
      itemId: 'it-1',
      direction: 'to_google',
      pushedHash: 'h1',
    });
    const updated = await CalendarLinkRepository.upsert('w-cal', 'i-gcal', key, {
      itemId: 'it-1',
      direction: 'to_google',
      lastEtag: 'etag-2',
    });
    assert.deepEqual([updated.id, updated.pushedHash, updated.lastEtag], [link.id, 'h1', 'etag-2']);
    assert.equal((await CalendarLinkRepository.findByItem('w-cal', 'i-gcal', 'it-1'))?.id, link.id);
    assert.equal((await CalendarLinkRepository.listLive('w-cal', 'i-gcal')).length, 1);

    const tombstoned = await CalendarLinkRepository.tombstone('w-cal', link.id, 'google');
    assert.ok(tombstoned?.tombstonedAt instanceof Date);
    assert.equal(tombstoned.deletedBy, 'google');
    assert.equal(await CalendarLinkRepository.tombstone('w-cal', link.id, 'dashboard'), null);
    assert.deepEqual(await CalendarLinkRepository.listLive('w-cal', 'i-gcal'), []);
    assert.equal(
      (await CalendarLinkRepository.findByItem('w-cal', 'i-gcal', 'it-1'))?.deletedBy,
      'google',
    );
  });

  it('a link that moves to another calendar keeps its row; lists by item; removes all', async () => {
    const first = await CalendarLinkRepository.upsert(
      'w-cal-2',
      'i-gcal-2',
      { calendarId: 'old-cal', googleEventId: 'el0002' },
      { itemId: 'it-2', direction: 'to_google', pushedHash: 'h1' },
    );
    await CalendarLinkRepository.tombstone('w-cal-2', first.id, 'dashboard');
    const moved = await CalendarLinkRepository.upsert(
      'w-cal-2',
      'i-gcal-2',
      { calendarId: 'new-cal', googleEventId: 'el0002' },
      { itemId: 'it-2', direction: 'to_google', pushedHash: 'h2', tombstonedAt: null },
    );
    assert.deepEqual(
      [moved.id, moved.calendarId, moved.tombstonedAt, moved.pushedHash],
      [first.id, 'new-cal', null, 'h2'],
    );
    await CalendarLinkRepository.upsert(
      'w-cal-2',
      'i-other',
      { calendarId: 'cal-x', googleEventId: 'el0002' },
      { itemId: 'it-2', direction: 'to_google' },
    );
    const forItem = await CalendarLinkRepository.listLiveForItem('w-cal-2', 'it-2');
    assert.deepEqual(forItem.map((link) => link.integrationId).sort(), ['i-gcal-2', 'i-other']);
    assert.deepEqual(await CalendarLinkRepository.listLiveForItem('w-other', 'it-2'), []);
    assert.equal(await CalendarLinkRepository.removeForIntegration('w-cal-2', 'i-gcal-2'), 1);
    assert.equal(await CalendarLinkRepository.findByItem('w-cal-2', 'i-gcal-2', 'it-2'), null);
    assert.equal((await CalendarLinkRepository.listLiveForItem('w-cal-2', 'it-2')).length, 1);
  });
});

describe('ReplayNonceRepository', () => {
  it('a duplicate nonce returns false instead of throwing', async () => {
    const expireAt = new Date(Date.now() + 10 * 60 * 1000);
    assert.equal(await ReplayNonceRepository.insert('w-hook', 'i-gcal', 'nonce-1', expireAt), true);
    assert.equal(
      await ReplayNonceRepository.insert('w-hook', 'i-gcal', 'nonce-1', expireAt),
      false,
    );
    assert.equal(await ReplayNonceRepository.insert('w-hook', 'i-gcal', 'nonce-2', expireAt), true);
  });
});
