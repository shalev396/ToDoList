import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { contextFor, hasStatus, newUser } from '../testing/workspaceFixtures.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type * as Models from '../models/index.js';
import type { UserData, WorkspaceData } from '../models/index.js';
import type { Role } from '../types/domain.js';
import type * as Workspaces from './workspaces.js';

let db: TestDatabase;
let workspaces: typeof Workspaces;
let models: typeof Models;

before(async () => {
  db = await startTestDatabase('todolist_members_test');
  const { syncDB } = await import('../config/database.js');
  await syncDB();
  workspaces = await import('./workspaces.js');
  models = await import('../models/index.js');
});

after(async () => {
  await db.stop();
});

interface Team {
  workspace: WorkspaceData;
  owner: UserData;
  editor: UserData;
  viewer: UserData;
}

/** A workspace with an owner, an editor and a viewer. */
async function newTeam(label: string): Promise<Team> {
  const owner = await newUser(`${label}-owner`);
  const editor = await newUser(`${label}-editor`);
  const viewer = await newUser(`${label}-viewer`);
  const workspace = await workspaces.createWorkspace(owner, { name: `Team ${label}` });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: editor.id, role: 'editor' });
  await memberships.create(workspace.id, { userId: viewer.id, role: 'viewer' });
  return { workspace, owner, editor, viewer };
}

async function roleOf(workspaceId: string, userId: string): Promise<Role | null> {
  const membership = await (await models.getMembershipRepository()).find(workspaceId, userId);
  return membership?.role ?? null;
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

describe('listMembers', () => {
  it('lists active members with their name and email, oldest first, to any member', async () => {
    const team = await newTeam('list');
    const members = await workspaces.listMembers(
      await contextFor(team.workspace.id, team.viewer.id),
    );
    assert.deepEqual(
      members.map((m) => [m.membership.userId, m.membership.role, m.name, m.email]),
      [
        [team.owner.id, 'owner', 'list-owner', 'list-owner@example.test'],
        [team.editor.id, 'editor', 'list-editor', 'list-editor@example.test'],
        [team.viewer.id, 'viewer', 'list-viewer', 'list-viewer@example.test'],
      ],
    );
  });
});

describe('updateMember', () => {
  it('owners change a member’s role', async () => {
    const team = await newTeam('update');
    const ctx = await contextFor(team.workspace.id, team.owner.id);
    const updated = await workspaces.updateMember(ctx, team.owner.id, team.viewer.id, {
      role: 'editor',
    });
    assert.equal(updated.role, 'editor');
    const [entry] = await (await models.getAuditLogRepository()).list(team.workspace.id, {}, 1);
    assert.deepEqual(
      [entry?.action, entry?.actorUserId, entry?.targetId],
      ['member.update', team.owner.id, team.viewer.id],
    );
  });

  it('cannot demote the last owner (409) or make anyone an owner (400)', async () => {
    const team = await newTeam('owner-rules');
    const ctx = await contextFor(team.workspace.id, team.owner.id);
    await assert.rejects(
      workspaces.updateMember(ctx, team.owner.id, team.owner.id, { role: 'editor' }),
      hasStatus(409),
    );
    await assert.rejects(
      workspaces.updateMember(ctx, team.owner.id, team.editor.id, { role: 'owner' }),
      hasStatus(400),
    );
    assert.deepEqual(
      [
        await roleOf(team.workspace.id, team.owner.id),
        await roleOf(team.workspace.id, team.editor.id),
      ],
      ['owner', 'editor'],
    );
  });

  it('refuses an empty patch (400) and a non-member (404)', async () => {
    const team = await newTeam('update-bad');
    const stranger = await newUser('update-bad-stranger');
    const ctx = await contextFor(team.workspace.id, team.owner.id);
    await assert.rejects(
      workspaces.updateMember(ctx, team.owner.id, team.viewer.id, {}),
      hasStatus(400),
    );
    await assert.rejects(
      workspaces.updateMember(ctx, team.owner.id, stranger.id, { role: 'viewer' }),
      hasStatus(404),
    );
  });

  it('with a second owner, an owner may be demoted', async () => {
    const team = await newTeam('two-owners');
    await (
      await models.getMembershipRepository()
    ).update(team.workspace.id, team.editor.id, {
      role: 'owner',
    });
    const ctx = await contextFor(team.workspace.id, team.owner.id);
    await workspaces.updateMember(ctx, team.owner.id, team.editor.id, { role: 'viewer' });
    assert.equal(await roleOf(team.workspace.id, team.editor.id), 'viewer');
  });
});

describe('removeMember', () => {
  it('owners remove a member, whose agent keys here are revoked', async () => {
    const team = await newTeam('remove');
    await giveKey(team.workspace.id, team.viewer.id, 'remove-viewer-key');
    const ctx = await contextFor(team.workspace.id, team.owner.id);
    await workspaces.removeMember(ctx, team.owner.id, team.viewer.id);
    assert.equal(await roleOf(team.workspace.id, team.viewer.id), null);
    const keys = await models.getAgentKeyRepository();
    assert.equal(await keys.countForUser(team.workspace.id, team.viewer.id), 0);
    const [entry] = await (await models.getAuditLogRepository()).list(team.workspace.id, {}, 1);
    assert.deepEqual([entry?.action, entry?.targetId], ['member.remove', team.viewer.id]);
    await assert.rejects(
      workspaces.removeMember(ctx, team.owner.id, team.viewer.id),
      hasStatus(404),
    );
  });

  it('cannot remove the last owner (409)', async () => {
    const team = await newTeam('remove-owner');
    const ctx = await contextFor(team.workspace.id, team.owner.id);
    await assert.rejects(
      workspaces.removeMember(ctx, team.owner.id, team.owner.id),
      hasStatus(409),
    );
    assert.equal(await roleOf(team.workspace.id, team.owner.id), 'owner');
  });
});

describe('non-owners cannot manage members', () => {
  for (const role of ['editor', 'viewer'] as const) {
    it(`a${role === 'editor' ? 'n' : ''} ${role} gets 403 and changes nothing`, async () => {
      const team = await newTeam(`no-${role}`);
      const actor = team[role];
      const ctx = await contextFor(team.workspace.id, actor.id);
      const target = role === 'editor' ? team.viewer : team.editor;
      await assert.rejects(
        workspaces.updateMember(ctx, actor.id, target.id, { role: 'viewer' }),
        hasStatus(403),
      );
      await assert.rejects(workspaces.removeMember(ctx, actor.id, target.id), hasStatus(403));
      await assert.rejects(workspaces.removeMember(ctx, actor.id, team.owner.id), hasStatus(403));
      assert.equal(
        await roleOf(team.workspace.id, target.id),
        target === team.viewer ? 'viewer' : 'editor',
      );
    });
  }
});

describe('leaveWorkspace', () => {
  it('any member but the last owner may leave; their agent keys here are revoked', async () => {
    const team = await newTeam('leave');
    await giveKey(team.workspace.id, team.editor.id, 'leave-editor-key');
    await workspaces.leaveWorkspace(
      await contextFor(team.workspace.id, team.editor.id),
      team.editor.id,
    );
    assert.equal(await roleOf(team.workspace.id, team.editor.id), null);
    assert.equal(
      await (await models.getAgentKeyRepository()).countForUser(team.workspace.id, team.editor.id),
      0,
    );
    const [entry] = await (await models.getAuditLogRepository()).list(team.workspace.id, {}, 1);
    assert.deepEqual([entry?.action, entry?.actorUserId], ['member.leave', team.editor.id]);
  });

  it('the last owner cannot leave (409)', async () => {
    const team = await newTeam('leave-owner');
    await assert.rejects(
      workspaces.leaveWorkspace(await contextFor(team.workspace.id, team.owner.id), team.owner.id),
      hasStatus(409),
    );
    assert.equal(await roleOf(team.workspace.id, team.owner.id), 'owner');
  });
});

describe('the agent behind a change', () => {
  async function actors(workspaceId: string, action: string): Promise<(string | null)[]> {
    const entries = await (await models.getAuditLogRepository()).list(workspaceId, { action }, 10);
    return entries.map((entry) => entry.actorAgentId);
  }

  it('is recorded on member.invite, member.update and member.remove when an agent acted', async () => {
    const team = await newTeam('agent-actor');
    const ctx = await contextFor(team.workspace.id, team.owner.id);
    await workspaces.createInvite(
      ctx,
      team.owner.id,
      { email: 'agent-invitee@example.test', role: 'viewer' },
      'agent-1',
    );
    await workspaces.updateMember(
      ctx,
      team.owner.id,
      team.viewer.id,
      { role: 'editor' },
      'agent-1',
    );
    await workspaces.removeMember(ctx, team.owner.id, team.editor.id, 'agent-1');
    for (const action of ['member.invite', 'member.update', 'member.remove']) {
      assert.deepEqual(await actors(team.workspace.id, action), ['agent-1'], action);
    }
  });

  it('is null when a person acted in the app (REST passes none)', async () => {
    const team = await newTeam('person-actor');
    const ctx = await contextFor(team.workspace.id, team.owner.id);
    await workspaces.createInvite(ctx, team.owner.id, {
      email: 'person-invitee@example.test',
      role: 'viewer',
    });
    await workspaces.updateMember(ctx, team.owner.id, team.viewer.id, { role: 'editor' });
    await workspaces.removeMember(ctx, team.owner.id, team.editor.id);
    for (const action of ['member.invite', 'member.update', 'member.remove']) {
      assert.deepEqual(await actors(team.workspace.id, action), [null], action);
    }
  });
});
