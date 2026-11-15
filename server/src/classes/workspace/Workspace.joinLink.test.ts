import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LIMITS } from '../../config/limits.js';
import {
  callerFor,
  contextFor,
  hasCode,
  hasStatus,
  newUser,
} from '../../testing/workspaceFixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type * as Models from '../../models/index.js';
import type { UserData } from '../../models/index.js';
import type * as Classes from './index.js';
import type { Workspace as WorkspaceEntity } from './index.js';
import { hashInviteToken, INVITE_TOKEN_PATTERN } from '../../services/inviteTokens.js';

let db: TestDatabase;
let Workspace: typeof Classes.Workspace;
let models: typeof Models;

before(async () => {
  db = await startTestDatabase('todolist_joinlink_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  ({ Workspace } = await import('./index.js'));
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

async function newWorkspace(
  label: string,
): Promise<{ owner: UserData; workspace: WorkspaceEntity }> {
  const owner = await newUser(`${label}-owner`);
  return { owner, workspace: await Workspace.create(owner, { name: `Link ${label}` }) };
}

describe('the join link', () => {
  it('starts restricted: no link, nothing to copy', async () => {
    const { owner, workspace } = await newWorkspace('off');
    const caller = await callerFor(workspace.id, owner.id);
    assert.deepEqual(await (await Workspace.load(caller)).getJoinLink(caller), {
      enabled: false,
      role: null,
      token: null,
    });
  });

  it('is turned on with a role, stores only the hash and a sealed token, and is audited without it', async () => {
    const { owner, workspace } = await newWorkspace('on');
    const caller = await callerFor(workspace.id, owner.id);
    const link = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'viewer' });
    assert.equal(link.enabled, true);
    assert.equal(link.role, 'viewer');
    assert.match(link.token ?? '', INVITE_TOKEN_PATTERN);
    // The owner can read the same link again.
    assert.deepEqual(await (await Workspace.load(caller)).getJoinLink(caller), link);

    const { WorkspaceMongoModel } = await import('../../models/mongoose/Workspace.js');
    const raw = await WorkspaceMongoModel.findById(workspace.id).lean();
    assert.equal(raw?.joinLink?.tokenHash, hashInviteToken(link.token ?? ''));
    assert.ok(!JSON.stringify(raw).includes(link.token ?? ''));

    const [entry] = await (await models.getAuditLogRepository()).list(workspace.id, {}, 1);
    assert.equal(entry?.action, 'workspace.link_update');
    assert.ok(!JSON.stringify(entry).includes(link.token ?? ''));
    assert.ok(!JSON.stringify(entry).includes(hashInviteToken(link.token ?? '')));
  });

  it('changes its role without changing the token; reset draws a new token that kills the old', async () => {
    const { owner, workspace } = await newWorkspace('reset');
    const caller = await callerFor(workspace.id, owner.id);
    const first = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'viewer' });
    const edit = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'editor' });
    assert.equal(edit.role, 'editor');
    assert.equal(edit.token, first.token);

    const reset = await (await Workspace.load(caller)).resetJoinLink(caller);
    assert.equal(reset.role, 'editor');
    assert.notEqual(reset.token, first.token);
    const guest = await newUser('reset-guest');
    await assert.rejects(Workspace.acceptJoinLink(first.token ?? '', guest), hasStatus(404));
    const joined = await Workspace.acceptJoinLink(reset.token ?? '', guest);
    assert.equal(joined.workspaceId, workspace.id);
  });

  it('is switched off by Restricted: the link then answers 404, and a reset needs it on', async () => {
    const { owner, workspace } = await newWorkspace('disable');
    const caller = await callerFor(workspace.id, owner.id);
    const on = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'viewer' });
    const off = await (await Workspace.load(caller)).setJoinLink(caller, { enabled: false });
    assert.deepEqual(off, { enabled: false, role: null, token: null });
    const guest = await newUser('disable-guest');
    await assert.rejects(Workspace.acceptJoinLink(on.token ?? '', guest), hasStatus(404));
    await assert.rejects((await Workspace.load(caller)).resetJoinLink(caller), hasStatus(409));
    // Turning it on again draws a fresh token.
    const again = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'viewer' });
    assert.notEqual(again.token, on.token);
  });

  it('is the owner alone', async () => {
    const { workspace } = await newWorkspace('perm');
    const editor = await newUser('perm-editor');
    await (
      await models.getMembershipRepository()
    ).create(workspace.id, { userId: editor.id, role: 'editor' });
    const caller = await callerFor(workspace.id, editor.id);
    await assert.rejects((await Workspace.load(caller)).getJoinLink(caller), hasStatus(403));
    await assert.rejects(
      (await Workspace.load(caller)).setJoinLink(caller, { enabled: true, role: 'viewer' }),
      hasStatus(403),
    );
    await assert.rejects((await Workspace.load(caller)).resetJoinLink(caller), hasStatus(403));
  });

  it('never grants owner', async () => {
    const { owner, workspace } = await newWorkspace('noowner');
    const caller = await callerFor(workspace.id, owner.id);
    await assert.rejects(
      (await Workspace.load(caller)).setJoinLink(caller, { enabled: true, role: 'owner' }),
      hasStatus(400),
    );
  });
});

describe('a join link whose sealed token cannot be opened', () => {
  it('still works for those who have it, shows no token, and a reset gives the owner a new one', async () => {
    const { owner, workspace } = await newWorkspace('unreadable');
    const caller = await callerFor(workspace.id, owner.id);
    const link = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'viewer' });
    const { WorkspaceMongoModel } = await import('../../models/mongoose/Workspace.js');
    await WorkspaceMongoModel.updateOne(
      { _id: workspace.id },
      { $set: { 'joinLink.enc.ciphertext': 'AAAA' } },
    );
    assert.deepEqual(await (await Workspace.load(caller)).getJoinLink(caller), {
      enabled: true,
      role: 'viewer',
      token: null,
    });
    const guest = await newUser('unreadable-guest');
    assert.deepEqual(await Workspace.acceptJoinLink(link.token ?? '', guest), {
      workspaceId: workspace.id,
    });
    const reset = await (await Workspace.load(caller)).resetJoinLink(caller);
    assert.match(reset.token ?? '', INVITE_TOKEN_PATTERN);
    assert.deepEqual(await (await Workspace.load(caller)).getJoinLink(caller), reset);
  });
});

describe('acceptJoinLink', () => {
  it('makes any signed-in user a member with the link role, whatever their email, and audits it', async () => {
    const { owner, workspace } = await newWorkspace('accept');
    const caller = await callerFor(workspace.id, owner.id);
    const link = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'viewer' });
    const guest = await newUser('accept-guest');
    const result = await Workspace.acceptJoinLink(link.token ?? '', guest);
    assert.deepEqual(result, { workspaceId: workspace.id });
    const membership = await (await models.getMembershipRepository()).find(workspace.id, guest.id);
    assert.equal(membership?.role, 'viewer');
    const [entry] = await (await models.getAuditLogRepository()).list(workspace.id, {}, 1);
    assert.equal(entry?.action, 'member.join_link');
    assert.equal(entry.actorUserId, guest.id);
    assert.ok(!JSON.stringify(entry).includes(link.token ?? ''));
  });

  it('gives an editor link editor, and 409 for someone already a member', async () => {
    const { owner, workspace } = await newWorkspace('editor');
    const caller = await callerFor(workspace.id, owner.id);
    const link = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'editor' });
    const guest = await newUser('editor-guest');
    await Workspace.acceptJoinLink(link.token ?? '', guest);
    assert.equal(
      (await (await models.getMembershipRepository()).find(workspace.id, guest.id))?.role,
      'editor',
    );
    await assert.rejects(
      Workspace.acceptJoinLink(link.token ?? '', guest),
      hasCode(409, 'already_member'),
    );
    // The owner opening their own link keeps their role.
    await assert.rejects(
      Workspace.acceptJoinLink(link.token ?? '', owner),
      hasCode(409, 'already_member'),
    );
    assert.equal((await contextFor(workspace.id, owner.id)).role, 'owner');
  });

  it('is 404 for an unknown or malformed token', async () => {
    const guest = await newUser('unknown-guest');
    await assert.rejects(Workspace.acceptJoinLink('nope', guest), hasStatus(404));
    await assert.rejects(Workspace.acceptJoinLink('a'.repeat(43), guest), hasStatus(404));
  });

  it('respects the member cap (409 workspace_full)', async () => {
    const { owner, workspace } = await newWorkspace('cap');
    const caller = await callerFor(workspace.id, owner.id);
    const link = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'viewer' });
    const memberships = await models.getMembershipRepository();
    const have = await memberships.countActive(workspace.id);
    for (let i = have; i < LIMITS.membersPerWorkspace; i += 1) {
      await memberships.create(workspace.id, { userId: `cap-${String(i)}`, role: 'viewer' });
    }
    const guest = await newUser('cap-guest');
    await assert.rejects(
      Workspace.acceptJoinLink(link.token ?? '', guest),
      hasCode(409, 'workspace_full'),
    );
    assert.equal(await memberships.find(workspace.id, guest.id), null);
  });

  it('answers 404 once the workspace is deleted', async () => {
    const { owner, workspace } = await newWorkspace('gone');
    const caller = await callerFor(workspace.id, owner.id);
    const link = await (
      await Workspace.load(caller)
    ).setJoinLink(caller, { enabled: true, role: 'viewer' });
    await (await Workspace.load(caller)).delete(caller);
    const guest = await newUser('gone-guest');
    await assert.rejects(Workspace.acceptJoinLink(link.token ?? '', guest), hasStatus(404));
  });
});
