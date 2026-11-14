import { after, before, describe, it, mock } from 'node:test';
import assert from 'node:assert/strict';

import { contextFor, hasStatus, newUser } from '../testing/workspaceFixtures.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type * as Models from '../models/index.js';
import type { UserData, WorkspaceData } from '../models/index.js';
import type { CredentialEnvelope } from '../models/definitions/Credential.js';
import type * as Workspaces from './workspaces.js';

let db: TestDatabase;
let workspaces: typeof Workspaces;
let models: typeof Models;

before(async () => {
  db = await startTestDatabase('todolist_cascade_test');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  workspaces = await import('./workspaces.js');
  models = await import('../models/index.js');
});

after(async () => {
  await db.stop();
});

const ENVELOPE: CredentialEnvelope = {
  alg: 'AES-256-GCM',
  keyProvider: 'aws-kms',
  kmsKeyArn: null,
  keyVersion: 1,
  wrappedDataKey: 'FAKE-wrapped',
  iv: 'FAKE-iv',
  authTag: 'FAKE-tag',
  ciphertext: 'FAKE-ciphertext',
  aad: 'FAKE-aad',
};

/** A workspace with a connected integration, its credential, items, a container and an invite. */
async function seedWorkspaceData(workspace: WorkspaceData, owner: UserData): Promise<void> {
  const integration = await (
    await models.getIntegrationRepository()
  ).create(workspace.id, {
    connectedBy: owner.id,
    provider: 'jira',
    accountId: `${workspace.slug}.example.invalid`,
    label: 'Jira',
    authMethod: 'api_token_basic',
    topicId: 'work',
  });
  await (
    await models.getCredentialRepository()
  ).upsertSealed(workspace.id, integration.id, {
    ownerUserId: owner.id,
    kind: 'api_token',
    enc: ENVELOPE,
  });
  const source = {
    provider: 'jira' as const,
    accountId: `${workspace.slug}.example.invalid`,
    externalId: 'project-1',
    key: null,
    url: 'https://example.invalid/project-1',
    updatedAtSource: null,
    etag: null,
    hash: 'sha1:p',
  };
  await (
    await models.getContainerRepository()
  ).bulkUpsert(workspace.id, [
    { integrationId: integration.id, topicId: 'work', type: 'project', name: 'Project', source },
  ]);
  const items = await models.getItemRepository();
  await items.bulkUpsert(workspace.id, [
    {
      integrationId: integration.id,
      kind: 'issue',
      topicId: 'work',
      title: 'Mirrored issue',
      status: 'open',
      source: { ...source, externalId: 'issue-1', hash: 'sha1:i' },
    },
  ]);
  await items.createLocal(workspace.id, { ownerUserId: owner.id, title: 'Local', topicId: 'work' });
  await workspaces.createInvite(await contextFor(workspace.id, owner.id), owner.id, {
    email: `pending-${workspace.slug}@example.test`,
    role: 'viewer',
  });
}

async function giveKey(workspaceId: string, userId: string, name: string): Promise<void> {
  await (
    await models.getAgentKeyRepository()
  ).create(workspaceId, {
    userId,
    name,
    keyHash: `hash-FAKE-${name}`,
    prefix: 'elk_FAKE',
    scopes: ['read'],
  });
}

/** What is left of a workspace, straight from the collections. */
async function remains(workspaceId: string): Promise<Record<string, unknown>> {
  const { CredentialMongoModel } = await import('../models/mongoose/Credential.js');
  const { IntegrationMongoModel } = await import('../models/mongoose/Integration.js');
  const { ItemMongoModel } = await import('../models/mongoose/Item.js');
  const { ContainerMongoModel } = await import('../models/mongoose/Container.js');
  const { WorkspaceMongoModel } = await import('../models/mongoose/Workspace.js');
  const live = { workspaceId, deletedAt: null };
  const workspace = await WorkspaceMongoModel.findById(workspaceId).lean();
  return {
    workspaceDeleted: workspace?.deletedAt instanceof Date,
    credentials: await CredentialMongoModel.countDocuments({ workspaceId }),
    liveIntegrations: await IntegrationMongoModel.countDocuments(live),
    liveItems: await ItemMongoModel.countDocuments(live),
    allItems: await ItemMongoModel.countDocuments({ workspaceId }),
    liveContainers: await ContainerMongoModel.countDocuments(live),
    members: (await (await models.getMembershipRepository()).listMembers(workspaceId)).length,
    pendingInvites: (
      await (await models.getInviteRepository()).listForWorkspace(workspaceId)
    ).filter((invite) => invite.status === 'pending').length,
  };
}

const UNTOUCHED = {
  workspaceDeleted: false,
  credentials: 1,
  liveIntegrations: 1,
  liveItems: 2,
  allItems: 2,
  liveContainers: 1,
  pendingInvites: 1,
};

const DELETED = {
  workspaceDeleted: true,
  credentials: 0,
  liveIntegrations: 0,
  liveItems: 0,
  allItems: 2,
  liveContainers: 0,
  members: 0,
  pendingInvites: 0,
};

describe('deleteWorkspace', () => {
  it('hard-deletes credentials, soft-deletes the rest, and ends every membership', async () => {
    const owner = await newUser('del-owner');
    const viewer = await newUser('del-viewer');
    const workspace = await workspaces.createWorkspace(owner, { name: 'Doomed' });
    await (
      await models.getMembershipRepository()
    ).create(workspace.id, {
      userId: viewer.id,
      role: 'viewer',
    });
    await seedWorkspaceData(workspace, owner);
    await giveKey(workspace.id, viewer.id, 'del-viewer-key');
    const bystanderOwner = await newUser('del-bystander');
    const bystander = await workspaces.createWorkspace(bystanderOwner, { name: 'Bystander' });
    await seedWorkspaceData(bystander, bystanderOwner);

    await workspaces.deleteWorkspace(await contextFor(workspace.id, owner.id), owner.id);

    assert.deepEqual(await remains(workspace.id), DELETED);
    assert.deepEqual(await remains(bystander.id), { ...UNTOUCHED, members: 1 });
    assert.equal(
      await (await models.getAgentKeyRepository()).countForUser(workspace.id, viewer.id),
      0,
    );
    const { getWorkspaceContext } = await import('./workspaceContext.js');
    assert.equal(await getWorkspaceContext(workspace.id, owner.id), null);
    assert.deepEqual(await workspaces.listMyWorkspaces(viewer.id), []);
    const [entry] = await (await models.getAuditLogRepository()).list(workspace.id, {}, 1);
    assert.deepEqual([entry?.action, entry?.actorUserId], ['workspace.delete', owner.id]);
  });

  it('is for owners only', async () => {
    const owner = await newUser('del-guard-owner');
    const editor = await newUser('del-guard-editor');
    const workspace = await workspaces.createWorkspace(owner, { name: 'Guarded' });
    await (
      await models.getMembershipRepository()
    ).create(workspace.id, {
      userId: editor.id,
      role: 'editor',
    });
    await seedWorkspaceData(workspace, owner);
    await assert.rejects(
      workspaces.deleteWorkspace(await contextFor(workspace.id, editor.id), editor.id),
      hasStatus(403),
    );
    assert.deepEqual(await remains(workspace.id), { ...UNTOUCHED, members: 2 });
  });
});

describe('deleteAccountCascade', () => {
  it('deletes workspaces the user solely owns and leaves the others, with their agent keys', async () => {
    const leaving = await newUser('acct-leaving');
    const coOwner = await newUser('acct-co-owner');
    const otherOwner = await newUser('acct-other-owner');
    const memberships = await models.getMembershipRepository();

    const solo = await workspaces.createWorkspace(leaving, { name: 'Solo' });
    await seedWorkspaceData(solo, leaving);
    // Two owners: ownership transfer is out of scope, so the second owner is set up directly.
    const shared = await workspaces.createWorkspace(leaving, { name: 'Shared' });
    await memberships.create(shared.id, { userId: coOwner.id, role: 'owner' });
    await seedWorkspaceData(shared, leaving);
    const theirs = await workspaces.createWorkspace(otherOwner, { name: 'Theirs' });
    await memberships.create(theirs.id, { userId: leaving.id, role: 'viewer' });
    for (const workspace of [solo, shared, theirs]) {
      await giveKey(workspace.id, leaving.id, `acct-${workspace.slug}`);
    }
    await giveKey(shared.id, coOwner.id, 'acct-co-owner-key');

    await workspaces.deleteAccountCascade(leaving.id);

    assert.deepEqual(await remains(solo.id), DELETED);
    // PERMISSIONS-V2 ruling 6: the integration they owned in the shared workspace is
    // disconnected (credential gone, its items and containers soft-deleted); their local to-do
    // stays.
    assert.deepEqual(await remains(shared.id), {
      ...UNTOUCHED,
      members: 1,
      credentials: 0,
      liveIntegrations: 0,
      liveItems: 1,
      liveContainers: 0,
    });
    assert.equal((await memberships.find(shared.id, coOwner.id))?.role, 'owner');
    assert.equal(await memberships.find(shared.id, leaving.id), null);
    assert.equal(await memberships.find(theirs.id, leaving.id), null);
    assert.equal((await memberships.find(theirs.id, otherOwner.id))?.role, 'owner');
    assert.deepEqual(await workspaces.listMyWorkspaces(leaving.id), []);

    const keys = await models.getAgentKeyRepository();
    for (const workspace of [solo, shared, theirs]) {
      assert.equal(await keys.countForUser(workspace.id, leaving.id), 0, workspace.name);
    }
    assert.equal(await keys.countForUser(shared.id, coOwner.id), 1);

    const audit = await models.getAuditLogRepository();
    assert.equal((await audit.list(solo.id, {}, 1))[0]?.action, 'workspace.delete');
    for (const workspace of [shared, theirs]) {
      const [entry] = await audit.list(workspace.id, {}, 1);
      assert.deepEqual(
        [entry?.action, entry?.actorUserId, entry?.meta['reason']],
        ['member.leave', leaving.id, 'account_deleted'],
      );
    }
  });

  it('runs before User.deleteAccount deletes the user row', async () => {
    const user = await newUser('acct-class');
    const workspace = await workspaces.createWorkspace(user, { name: 'Class workspace' });
    const { User } = await import('../classes/User.js');
    await User.deleteAccount(user.id, user.cognitoSub);
    assert.equal(await (await models.getUserRepository()).findById(user.id), null);
    assert.equal((await remains(workspace.id))['workspaceDeleted'], true);
    assert.deepEqual(await workspaces.listMyWorkspaces(user.id), []);
  });
});

/** A member's own Jira integration with its credential and one mirrored item. */
async function seedOwnIntegration(workspace: WorkspaceData, member: UserData): Promise<string> {
  const integration = await (
    await models.getIntegrationRepository()
  ).create(workspace.id, {
    connectedBy: member.id,
    provider: 'jira',
    accountId: `${member.id}.example.invalid`,
    label: 'Jira',
    authMethod: 'api_token_basic',
    topicId: 'work',
  });
  await (
    await models.getCredentialRepository()
  ).upsertSealed(workspace.id, integration.id, {
    ownerUserId: member.id,
    kind: 'api_token',
    enc: ENVELOPE,
  });
  await (
    await models.getItemRepository()
  ).bulkUpsert(workspace.id, [
    {
      integrationId: integration.id,
      kind: 'issue',
      topicId: 'work',
      title: 'Their issue',
      status: 'open',
      source: {
        provider: 'jira',
        accountId: `${member.id}.example.invalid`,
        externalId: 'issue-1',
        key: null,
        url: 'https://example.invalid/issue-1',
        updatedAtSource: null,
        etag: null,
        hash: 'sha1:i',
      },
    },
  ]);
  return integration.id;
}

describe('ending a membership (PERMISSIONS-V2 ruling 6)', () => {
  it('ends access before disconnecting; the owner finishes a disconnect that stopped part-way', async () => {
    const owner = await newUser('end-owner');
    const editor = await newUser('end-editor');
    const workspace = await workspaces.createWorkspace(owner, { name: 'Ending' });
    const memberships = await models.getMembershipRepository();
    await memberships.create(workspace.id, { userId: editor.id, role: 'editor' });
    const integrationId = await seedOwnIntegration(workspace, editor);
    const credentials = await models.getCredentialRepository();
    const { ItemMongoModel } = await import('../models/mongoose/Item.js');
    const liveItems = (): Promise<number> =>
      ItemMongoModel.countDocuments({ workspaceId: workspace.id, integrationId, deletedAt: null });

    // The vault fails right after the integration's soft delete (step 2 of the disconnect).
    const failing = mock.method(credentials, 'delete', () =>
      Promise.reject(new Error('vault down')),
    );
    try {
      await assert.rejects(
        workspaces.leaveWorkspace(await contextFor(workspace.id, editor.id), editor.id),
        /vault down/,
      );
    } finally {
      failing.mock.restore();
    }
    // M6: their access ended first, so nothing of theirs can be connected or attached meanwhile.
    assert.equal(await memberships.find(workspace.id, editor.id), null);
    assert.equal(
      await (await models.getIntegrationRepository()).findById(workspace.id, integrationId),
      null,
    );
    assert.notEqual(await credentials.findMeta(workspace.id, integrationId), null);
    assert.equal(await liveItems(), 1);

    // M5: removing them again finishes it, soft-deleted integration included.
    const ownerCtx = await contextFor(workspace.id, owner.id);
    await workspaces.removeMember(ownerCtx, owner.id, editor.id);
    assert.equal(await credentials.findMeta(workspace.id, integrationId), null);
    assert.equal(await liveItems(), 0);

    // Someone who was never a member here and owns nothing here: 404.
    const stranger = await newUser('end-stranger');
    await assert.rejects(workspaces.removeMember(ownerCtx, owner.id, stranger.id), hasStatus(404));
  });
});
