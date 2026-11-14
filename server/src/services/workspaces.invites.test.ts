import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../config/limits.js';
import { contextFor, hasStatus, newUser } from '../testing/workspaceFixtures.js';
import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type * as Models from '../models/index.js';
import type { UserData, WorkspaceData } from '../models/index.js';
import type * as Workspaces from './workspaces.js';
import { hashInviteToken, INVITE_TOKEN_PATTERN } from './inviteTokens.js';

const DAY = 24 * 60 * 60 * 1000;

let db: TestDatabase;
let workspaces: typeof Workspaces;
let models: typeof Models;

before(async () => {
  db = await startTestDatabase('todolist_invites_test');
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
  role: 'editor' | 'viewer' = 'viewer',
): Promise<{ inviteId: string; rawToken: string }> {
  const ctx = await contextFor(workspace.workspace.id, workspace.owner.id);
  const { invite: created, rawToken } = await workspaces.createInvite(ctx, workspace.owner.id, {
    email,
    role,
  });
  return { inviteId: created.id, rawToken };
}

/**
 * Moves the workspace's sent invites (AuditLogs `member.invite`, what the email limits count)
 * back in time, as if `ms` had passed.
 */
async function age(workspaceId: string, ms: number): Promise<void> {
  const { AuditLogMongoModel } = await import('../models/mongoose/AuditLog.js');
  const sent = await AuditLogMongoModel.find({ workspaceId, action: 'member.invite' }).lean();
  for (const entry of sent) {
    await AuditLogMongoModel.updateOne(
      { _id: entry._id },
      { $set: { at: new Date(entry.at.getTime() - ms) } },
    );
  }
}

/** Members added straight to the database, to fill a workspace up. */
async function addMembers(workspaceId: string, count: number, prefix: string): Promise<void> {
  const memberships = await models.getMembershipRepository();
  for (let i = 0; i < count; i += 1) {
    await memberships.create(workspaceId, { userId: `${prefix}-${String(i)}`, role: 'viewer' });
  }
}

describe('createInvite', () => {
  it('stores only the SHA-256 of the raw token, and expires in 7 days', async () => {
    const workspace = await newWorkspace('hash');
    const ctx = await contextFor(workspace.workspace.id, workspace.owner.id);
    const before = Date.now();
    const { invite: created, rawToken } = await workspaces.createInvite(ctx, workspace.owner.id, {
      email: ' Friend@Example.Test ',
      role: 'viewer',
    });
    assert.match(rawToken, INVITE_TOKEN_PATTERN);
    assert.equal(created.email, 'friend@example.test');
    assert.equal(created.status, 'pending');
    assert.ok(!('tokenHash' in created));
    const ttl = created.expiresAt.getTime() - before;
    assert.ok(ttl >= 7 * DAY - 1000 && ttl <= 7 * DAY + 5000, String(ttl));

    const { InviteMongoModel } = await import('../models/mongoose/Invite.js');
    const raw = await InviteMongoModel.findById(created.id).lean();
    assert.equal(raw?.tokenHash, hashInviteToken(rawToken));
    assert.ok(!JSON.stringify(raw).includes(rawToken));

    const [entry] = await (
      await models.getAuditLogRepository()
    ).list(workspace.workspace.id, {}, 1);
    assert.deepEqual(
      [entry?.action, entry?.actorUserId, entry?.targetType, entry?.targetId],
      ['member.invite', workspace.owner.id, 'invite', created.id],
    );
    const logged = JSON.stringify(entry);
    assert.ok(!logged.includes(rawToken) && !logged.includes(hashInviteToken(rawToken)));
  });

  it('only owners invite', async () => {
    const workspace = await newWorkspace('perm');
    const memberships = await models.getMembershipRepository();
    for (const role of ['editor', 'viewer'] as const) {
      const member = await newUser(`perm-${role}`);
      await memberships.create(workspace.workspace.id, { userId: member.id, role });
      const ctx = await contextFor(workspace.workspace.id, member.id);
      await assert.rejects(
        workspaces.createInvite(ctx, member.id, { email: 'x@example.test', role: 'viewer' }),
        hasStatus(403),
      );
    }
  });

  it('refuses the owner role (400) and anyone already a member (409)', async () => {
    const workspace = await newWorkspace('refuse');
    const ctx = await contextFor(workspace.workspace.id, workspace.owner.id);
    await assert.rejects(
      workspaces.createInvite(ctx, workspace.owner.id, {
        email: 'boss@example.test',
        role: 'owner',
      }),
      hasStatus(400),
    );
    const member = await newUser('refuse-member');
    await (
      await models.getMembershipRepository()
    ).create(workspace.workspace.id, {
      userId: member.id,
      role: 'viewer',
    });
    await assert.rejects(
      workspaces.createInvite(ctx, workspace.owner.id, {
        email: 'REFUSE-member@example.test',
        role: 'editor',
      }),
      hasStatus(409),
    );
    await assert.rejects(
      workspaces.createInvite(ctx, workspace.owner.id, {
        email: workspace.owner.email ?? '',
        role: 'editor',
      }),
      hasStatus(409),
    );
  });

  it('inviting the same email again replaces the pending invite', async () => {
    const workspace = await newWorkspace('again');
    const first = await invite(workspace, 'twice@example.test');
    await age(workspace.workspace.id, LIMITS.inviteResendCooldownMs);
    const second = await invite(workspace, 'twice@example.test', 'editor');
    assert.notEqual(first.rawToken, second.rawToken);
    const statuses = (
      await workspaces.listInvites(await contextFor(workspace.workspace.id, workspace.owner.id))
    ).map((inv) => [inv.id, inv.status]);
    assert.deepEqual(statuses, [
      [second.inviteId, 'pending'],
      [first.inviteId, 'revoked'],
    ]);
  });

  it('enforces membersPerWorkspace, counting pending invites', async () => {
    const workspace = await newWorkspace('full');
    await addMembers(workspace.workspace.id, 23, 'full'); // 24 active with the owner
    await invite(workspace, 'last-seat@example.test'); // 24 + 1 pending = 25
    const ctx = await contextFor(workspace.workspace.id, workspace.owner.id);
    await assert.rejects(
      workspaces.createInvite(ctx, workspace.owner.id, {
        email: 'one-too-many@example.test',
        role: 'viewer',
      }),
      hasStatus(409),
    );
    // Re-inviting a pending email reuses its seat.
    await age(workspace.workspace.id, LIMITS.inviteResendCooldownMs);
    assert.match(
      (await invite(workspace, 'last-seat@example.test')).rawToken,
      INVITE_TOKEN_PATTERN,
    );
  });
});

describe('invite email limits (429)', () => {
  const DAILY = LIMITS.inviteEmailsPerWorkspacePerDay;

  it('a workspace sends at most inviteEmailsPerWorkspacePerDay invites in 24 hours, withdrawn ones included', async () => {
    const workspace = await newWorkspace('daily');
    const ctx = await contextFor(workspace.workspace.id, workspace.owner.id);
    for (let i = 0; i < DAILY; i += 1) {
      const { invite: sent } = await workspaces.createInvite(ctx, workspace.owner.id, {
        email: `daily-${String(i)}@example.test`,
        role: 'viewer',
      });
      // Withdrawn at once (it keeps the member cap out of the way); the email went out anyway.
      await workspaces.revokeInvite(ctx, workspace.owner.id, sent.id);
    }
    await assert.rejects(
      workspaces.createInvite(ctx, workspace.owner.id, {
        email: 'one-more@example.test',
        role: 'viewer',
      }),
      (error: unknown) =>
        hasStatus(429)(error) &&
        (error as Error).message ===
          `A workspace can send at most ${String(DAILY)} invites in 24 hours. Try again later.`,
    );
    assert.equal(
      (await workspaces.listInvites(ctx)).length,
      DAILY,
      'the refused invite was not created',
    );

    // A day later those have left the window.
    await age(workspace.workspace.id, DAY);
    assert.match((await invite(workspace, 'one-more@example.test')).rawToken, INVITE_TOKEN_PATTERN);
  });

  it('the same address gets at most one invite per inviteResendCooldownMs, per workspace', async () => {
    const workspace = await newWorkspace('cooldown');
    const elsewhere = await newWorkspace('cooldown-elsewhere');
    const first = await invite(workspace, 'again@example.test');
    const ctx = await contextFor(workspace.workspace.id, workspace.owner.id);
    await assert.rejects(
      workspaces.createInvite(ctx, workspace.owner.id, {
        email: ' AGAIN@example.test ',
        role: 'editor',
      }),
      (error: unknown) =>
        hasStatus(429)(error) &&
        (error as Error).message ===
          'An invite was sent to this email less than 10 minutes ago. Try again later.',
    );
    // Other addresses, and the same address from another workspace, are not held back.
    await invite(workspace, 'someone-else@example.test');
    await invite(elsewhere, 'again@example.test');
    const pendingFor = async (email: string): Promise<string[]> =>
      (await workspaces.listInvites(ctx))
        .filter((inv) => inv.email === email && inv.status === 'pending')
        .map((inv) => inv.id);
    assert.deepEqual(await pendingFor('again@example.test'), [first.inviteId]);

    // Once the cooldown has passed, re-sending works (and replaces the pending invite).
    await age(workspace.workspace.id, LIMITS.inviteResendCooldownMs);
    const second = await invite(workspace, 'again@example.test', 'editor');
    assert.deepEqual(await pendingFor('again@example.test'), [second.inviteId]);
  });
});

describe('acceptInvite', () => {
  it('makes the invitee a member of the whole workspace with exactly the invited role', async () => {
    const workspace = await newWorkspace('accept');
    const classmate = await newUser('classmate');
    const { inviteId, rawToken } = await invite(workspace, 'Classmate@example.test', 'viewer');
    assert.deepEqual(await workspaces.acceptInvite(classmate, rawToken), {
      workspaceId: workspace.workspace.id,
    });
    const membership = await (
      await models.getMembershipRepository()
    ).find(workspace.workspace.id, classmate.id);
    assert.deepEqual([membership?.role, membership?.invitedBy], ['viewer', workspace.owner.id]);
    const ctx = await contextFor(workspace.workspace.id, classmate.id);
    assert.equal(ctx.role, 'viewer');

    const [accepted] = await workspaces.listInvites(
      await contextFor(workspace.workspace.id, workspace.owner.id),
    );
    assert.deepEqual(
      [accepted?.id, accepted?.status, accepted?.acceptedBy],
      [inviteId, 'accepted', classmate.id],
    );
    const [entry] = await (
      await models.getAuditLogRepository()
    ).list(workspace.workspace.id, {}, 1);
    assert.deepEqual([entry?.action, entry?.actorUserId], ['member.join', classmate.id]);
  });

  it('answers 403 to someone whose email is not the invited one, and leaves the invite usable', async () => {
    const workspace = await newWorkspace('wrong');
    const intruder = await newUser('intruder');
    const invitee = await newUser('invitee');
    const { rawToken } = await invite(workspace, 'invitee@example.test');
    await assert.rejects(workspaces.acceptInvite(intruder, rawToken), hasStatus(403));
    await assert.rejects(
      workspaces.acceptInvite({ id: intruder.id, email: null }, rawToken),
      hasStatus(403),
    );
    assert.equal(
      await (await models.getMembershipRepository()).find(workspace.workspace.id, intruder.id),
      null,
    );
    assert.deepEqual(await workspaces.acceptInvite(invitee, rawToken), {
      workspaceId: workspace.workspace.id,
    });
  });

  it('answers 410 (or 404) to an expired invite and 410 to a revoked one', async () => {
    const workspace = await newWorkspace('gone');
    const late = await newUser('late');
    const expired = await invite(workspace, 'late@example.test');
    const { InviteMongoModel } = await import('../models/mongoose/Invite.js');
    await InviteMongoModel.updateOne(
      { _id: expired.inviteId },
      { $set: { expiresAt: new Date(Date.now() - 1000) } },
    );
    // The Invites TTL index deletes expired invites (its monitor sweeps about once a minute): 410
    // while the expired invite still exists, 404 once it is gone. Either may happen here.
    await assert.rejects(
      workspaces.acceptInvite(late, expired.rawToken),
      (error: unknown) => hasStatus(410)(error) || hasStatus(404)(error),
    );

    await age(workspace.workspace.id, LIMITS.inviteResendCooldownMs);
    const revoked = await invite(workspace, 'late@example.test');
    await workspaces.revokeInvite(
      await contextFor(workspace.workspace.id, workspace.owner.id),
      workspace.owner.id,
      revoked.inviteId,
    );
    await assert.rejects(workspaces.acceptInvite(late, revoked.rawToken), hasStatus(410));
    assert.equal(
      await (await models.getMembershipRepository()).find(workspace.workspace.id, late.id),
      null,
    );
  });

  it('answers 409 when the invite is used again', async () => {
    const workspace = await newWorkspace('reuse');
    const friend = await newUser('reuse-friend');
    const { rawToken } = await invite(workspace, 'reuse-friend@example.test');
    await workspaces.acceptInvite(friend, rawToken);
    await assert.rejects(workspaces.acceptInvite(friend, rawToken), hasStatus(409));
  });

  it('answers 404 to a token that matches no invite', async () => {
    const someone = await newUser('guesser');
    await assert.rejects(workspaces.acceptInvite(someone, 'A'.repeat(43)), hasStatus(404));
    await assert.rejects(workspaces.acceptInvite(someone, 'not a token'), hasStatus(404));
  });

  it('answers 409 when the workspace filled up after the invite was sent', async () => {
    const workspace = await newWorkspace('crowded');
    const latecomer = await newUser('latecomer');
    await addMembers(workspace.workspace.id, 23, 'crowded'); // 24 active
    const { rawToken } = await invite(workspace, 'latecomer@example.test');
    await addMembers(workspace.workspace.id, 1, 'crowded-extra'); // 25 active
    await assert.rejects(workspaces.acceptInvite(latecomer, rawToken), hasStatus(409));
    assert.equal(
      await (await models.getMembershipRepository()).find(workspace.workspace.id, latecomer.id),
      null,
    );
  });

  it('answers 410 when the workspace was deleted', async () => {
    const workspace = await newWorkspace('vanished');
    const guest = await newUser('vanished-guest');
    const { rawToken } = await invite(workspace, 'vanished-guest@example.test');
    await (await models.getWorkspaceRepository()).softDelete(workspace.workspace.id);
    await assert.rejects(workspaces.acceptInvite(guest, rawToken), hasStatus(410));
  });
});

describe('invite lists', () => {
  it('listPendingInvitesForUser: my pending invites with workspace names, whatever the case', async () => {
    const a = await newWorkspace('pending-a');
    const b = await newWorkspace('pending-b');
    const c = await newWorkspace('pending-c');
    await invite(a, 'onboarding@example.test', 'editor');
    await invite(b, 'ONBOARDING@example.test', 'viewer');
    const used = await invite(c, 'onboarding@example.test');
    await workspaces.acceptInvite(await newUser('onboarding'), used.rawToken);

    const pending = await workspaces.listPendingInvitesForUser('Onboarding@Example.Test');
    assert.deepEqual(
      pending.map((p) => [p.workspaceName, p.invite.role]),
      [
        ['Workspace pending-b', 'viewer'],
        ['Workspace pending-a', 'editor'],
      ],
    );
  });

  it('listInvites and revokeInvite are for owners; revoking twice is 404', async () => {
    const workspace = await newWorkspace('revoke');
    const editor = await newUser('revoke-editor');
    await (
      await models.getMembershipRepository()
    ).create(workspace.workspace.id, {
      userId: editor.id,
      role: 'editor',
    });
    const { inviteId } = await invite(workspace, 'revokee@example.test');
    const asEditor = await contextFor(workspace.workspace.id, editor.id);
    await assert.rejects(workspaces.listInvites(asEditor), hasStatus(403));
    await assert.rejects(workspaces.revokeInvite(asEditor, editor.id, inviteId), hasStatus(403));

    const asOwner = await contextFor(workspace.workspace.id, workspace.owner.id);
    await workspaces.revokeInvite(asOwner, workspace.owner.id, inviteId);
    await assert.rejects(
      workspaces.revokeInvite(asOwner, workspace.owner.id, inviteId),
      hasStatus(404),
    );
    const [entry] = await (
      await models.getAuditLogRepository()
    ).list(workspace.workspace.id, {}, 1);
    assert.deepEqual([entry?.action, entry?.targetId], ['invite.revoke', inviteId]);
  });
});
