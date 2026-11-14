/**
 * Machine codes on the workspace and invite errors the UI translates (types/errorCodes.ts).
 * Messages stay generic; the code tells the client which text to show.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../config/limits.js';
import { contextFor, hasCode, newUser } from '../testing/workspaceFixtures.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type * as Models from '../models/index.js';
import type { UserData, WorkspaceData } from '../models/index.js';
import type * as Workspaces from './workspaces.js';

let db: TestDatabase;
let workspaces: typeof Workspaces;
let models: typeof Models;

before(async () => {
  db = await startTestDatabase('todolist_error_codes_test');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  workspaces = await import('./workspaces.js');
  models = await import('../models/index.js');
});

after(async () => {
  await db.stop();
});

interface Workspace {
  owner: UserData;
  workspace: WorkspaceData;
}

async function newWorkspace(label: string): Promise<Workspace> {
  const owner = await newUser(`${label}-owner`);
  const workspace = await workspaces.createWorkspace(owner, { name: `Workspace ${label}` });
  return { owner, workspace };
}

async function invite(
  workspace: Workspace,
  email: string,
): Promise<{ inviteId: string; rawToken: string }> {
  const ctx = await contextFor(workspace.workspace.id, workspace.owner.id);
  const { invite: created, rawToken } = await workspaces.createInvite(ctx, workspace.owner.id, {
    email,
    role: 'viewer',
  });
  return { inviteId: created.id, rawToken };
}

async function addMembers(workspaceId: string, count: number, prefix: string): Promise<void> {
  const memberships = await models.getMembershipRepository();
  for (let i = 0; i < count; i += 1) {
    await memberships.create(workspaceId, { userId: `${prefix}-${String(i)}`, role: 'viewer' });
  }
}

describe('workspace codes', () => {
  it('slug_taken: a chosen slug someone holds', async () => {
    const first = await newWorkspace('slug-a');
    const other = await newUser('slug-b');
    await assert.rejects(
      workspaces.createWorkspace(other, { name: 'Mine', slug: first.workspace.slug }),
      hasCode(409, 'slug_taken'),
    );
  });

  it('workspace_limit: one workspace more than a person may own', async () => {
    const owner = await newUser('collector');
    for (let i = 0; i < LIMITS.workspacesCreatedPerUser; i += 1) {
      await workspaces.createWorkspace(owner, { name: `Workspace ${String(i)}` });
    }
    await assert.rejects(
      workspaces.createWorkspace(owner, { name: 'One too many' }),
      hasCode(409, 'workspace_limit'),
    );
  });

  it('last_owner: the only owner can neither leave nor be removed', async () => {
    const workspace = await newWorkspace('lonely');
    const ctx = await contextFor(workspace.workspace.id, workspace.owner.id);
    await assert.rejects(
      workspaces.leaveWorkspace(ctx, workspace.owner.id),
      hasCode(409, 'last_owner'),
    );
    await assert.rejects(
      workspaces.removeMember(ctx, workspace.owner.id, workspace.owner.id),
      hasCode(409, 'last_owner'),
    );
  });
});

describe('invite codes', () => {
  it('already_member: inviting someone who is in', async () => {
    const workspace = await newWorkspace('member-again');
    const friend = await newUser('member-again-friend');
    const { rawToken } = await invite(workspace, friend.email ?? '');
    await workspaces.acceptInvite(friend, rawToken);
    await assert.rejects(invite(workspace, friend.email ?? ''), hasCode(409, 'already_member'));
  });

  it('workspace_full: no seat left for another invite', async () => {
    const workspace = await newWorkspace('packed');
    await addMembers(workspace.workspace.id, LIMITS.membersPerWorkspace - 1, 'packed');
    await assert.rejects(
      invite(workspace, 'one-more@example.test'),
      hasCode(409, 'workspace_full'),
    );
  });

  it('invite_rate_limited: the same address again within the cooldown', async () => {
    const workspace = await newWorkspace('eager');
    await invite(workspace, 'eager-friend@example.test');
    await assert.rejects(
      invite(workspace, 'eager-friend@example.test'),
      hasCode(429, 'invite_rate_limited'),
    );
  });
});

describe('accept codes', () => {
  it('email_mismatch: someone else opens the link', async () => {
    const workspace = await newWorkspace('mismatch');
    const stranger = await newUser('mismatch-stranger');
    const { rawToken } = await invite(workspace, 'mismatch-friend@example.test');
    await assert.rejects(
      workspaces.acceptInvite(stranger, rawToken),
      hasCode(403, 'email_mismatch'),
    );
  });

  it('invite_used: the link a second time', async () => {
    const workspace = await newWorkspace('twice');
    const friend = await newUser('twice-friend');
    const { rawToken } = await invite(workspace, 'twice-friend@example.test');
    await workspaces.acceptInvite(friend, rawToken);
    await assert.rejects(workspaces.acceptInvite(friend, rawToken), hasCode(409, 'invite_used'));
  });

  it('invite_expired: a withdrawn link', async () => {
    const workspace = await newWorkspace('withdrawn');
    const friend = await newUser('withdrawn-friend');
    const { inviteId, rawToken } = await invite(workspace, 'withdrawn-friend@example.test');
    await workspaces.revokeInvite(
      await contextFor(workspace.workspace.id, workspace.owner.id),
      workspace.owner.id,
      inviteId,
    );
    await assert.rejects(workspaces.acceptInvite(friend, rawToken), hasCode(410, 'invite_expired'));
  });

  it('invite_expired: the workspace is gone', async () => {
    const workspace = await newWorkspace('deleted');
    const friend = await newUser('deleted-friend');
    const { rawToken } = await invite(workspace, 'deleted-friend@example.test');
    await (await models.getWorkspaceRepository()).softDelete(workspace.workspace.id);
    await assert.rejects(workspaces.acceptInvite(friend, rawToken), hasCode(410, 'invite_expired'));
  });

  it('already_member: joining a workspace I am already in', async () => {
    const workspace = await newWorkspace('inside');
    const friend = await newUser('inside-friend');
    const { rawToken } = await invite(workspace, 'inside-friend@example.test');
    await (
      await models.getMembershipRepository()
    ).create(workspace.workspace.id, {
      userId: friend.id,
      role: 'viewer',
    });
    await assert.rejects(workspaces.acceptInvite(friend, rawToken), hasCode(409, 'already_member'));
  });

  it('workspace_full: the workspace filled up after the invite was sent', async () => {
    const workspace = await newWorkspace('crowded');
    const latecomer = await newUser('crowded-latecomer');
    await addMembers(workspace.workspace.id, LIMITS.membersPerWorkspace - 2, 'crowded');
    const { rawToken } = await invite(workspace, 'crowded-latecomer@example.test');
    await addMembers(workspace.workspace.id, 1, 'crowded-extra');
    await assert.rejects(
      workspaces.acceptInvite(latecomer, rawToken),
      hasCode(409, 'workspace_full'),
    );
  });

  it('messages stay generic: none echoes the email or the token', async () => {
    const workspace = await newWorkspace('quiet');
    const stranger = await newUser('quiet-stranger');
    const { rawToken } = await invite(workspace, 'quiet-friend@example.test');
    await assert.rejects(workspaces.acceptInvite(stranger, rawToken), (error: unknown) => {
      const message = (error as Error).message;
      return !message.includes('quiet') && !message.includes(rawToken);
    });
  });
});
