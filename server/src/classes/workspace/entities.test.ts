import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { callerFor, hasStatus, newUser } from '../../testing/workspaceFixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type * as WorkspaceClasses from './index.js';

let db: TestDatabase;
let classes: typeof WorkspaceClasses;

before(async () => {
  db = await startTestDatabase('todolist_workspace_entities_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  classes = await import('./index.js');
});

after(async () => {
  await db.stop();
});

describe('the workspace entities and their contracts', () => {
  it('Workspace is auditable and soft-deletable, and composes its value objects', async () => {
    const { Workspace, WorkspaceSettings, AttributeDefinitions, TopicRules } = classes;
    const owner = await newUser('entity-owner');
    const workspace = await Workspace.create(owner, { name: 'Entities' });
    assert.deepEqual(workspace.auditTarget().toJSON(), { type: 'workspace', id: workspace.id });
    assert.equal(workspace.isDeleted, false);
    assert.equal(workspace.deletedAt, null);
    assert.ok(workspace.settings instanceof WorkspaceSettings);
    assert.ok(workspace.settings.attributes instanceof AttributeDefinitions);
    assert.ok(workspace.settings.topicRules instanceof TopicRules);
    assert.ok(workspace.equals((await Workspace.listFor(owner.id))[0]?.workspace));
    // The data it hands out is a copy.
    const data = workspace.toJSON();
    data.name = 'Changed';
    assert.equal(workspace.name, 'Entities');

    const caller = await callerFor(workspace.id, owner.id);
    await workspace.delete(caller);
    await assert.rejects(Workspace.load(caller), hasStatus(404));
  });

  it('Member carries the role as a value object and the person, and is auditable', async () => {
    const { Workspace, Member } = classes;
    const owner = await newUser('entity-member');
    const workspace = await Workspace.create(owner, { name: 'Members' });
    const [member] = await Member.list(await callerFor(workspace.id, owner.id));
    assert.ok(member);
    assert.equal(member.role.name, 'owner');
    assert.ok(member.role.atLeast('editor'));
    assert.equal(member.name, 'entity-member');
    assert.equal(member.workspaceId, workspace.id);
    assert.deepEqual(member.auditTarget().toJSON(), { type: 'user', id: owner.id });
  });

  it('Invite is expirable and revocable by an owner', async () => {
    const { Workspace, Invite } = classes;
    const owner = await newUser('entity-invite');
    const workspace = await Workspace.create(owner, { name: 'Invites' });
    const caller = await callerFor(workspace.id, owner.id);
    const { invite } = await Invite.create(caller, {
      email: 'friend@example.test',
      role: 'viewer',
    });
    const now = new Date();
    assert.equal(invite.isExpired(now), false);
    assert.equal(invite.isPending(now), true);
    assert.equal(invite.isExpired(new Date(invite.expiresAt.getTime() + 1)), true);
    assert.equal(invite.role.name, 'viewer');
    assert.deepEqual(invite.auditTarget().toJSON(), { type: 'invite', id: invite.id });

    await invite.revoke(caller);
    await assert.rejects(Invite.pending(caller, invite.id), hasStatus(404));
    const [listed] = await Invite.list(caller);
    assert.equal(listed?.status, 'revoked');
  });

  it('Topic is a workspace entity, auditable, found by slug', async () => {
    const { Workspace, Topic } = classes;
    const owner = await newUser('entity-topic');
    const workspace = await Workspace.create(owner, { name: 'Topics' });
    const caller = await callerFor(workspace.id, owner.id);
    const topic = await Topic.create(caller, { name: 'Reading list' });
    assert.equal(topic.workspaceId, workspace.id);
    assert.equal(topic.slug, 'reading-list');
    assert.deepEqual(topic.auditTarget().toJSON(), { type: 'topic', id: topic.id });
    assert.ok(topic.equals(await Topic.bySlug(workspace.id, 'reading-list')));
    assert.equal(await Topic.bySlug(workspace.id, 'missing'), null);
    await assert.rejects(Topic.assertOf(workspace.id, 'no-such-topic'), hasStatus(400));
  });
});
