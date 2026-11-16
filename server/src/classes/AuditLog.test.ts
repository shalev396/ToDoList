import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { AuditLog as AuditLogClass } from './AuditLog.js';
import type { Actor as ActorClass } from './base/Actor.js';
import type { AuditTarget as AuditTargetClass } from './base/AuditTarget.js';
import type { Caller as CallerClass } from './base/Caller.js';
import type { Auditable } from './base/contracts.js';

let db: TestDatabase;

before(async () => {
  db = await startTestDatabase('todolist_classes_audit_log');
});

after(async () => {
  await db.stop();
});

async function classes(): Promise<{
  AuditLog: typeof AuditLogClass;
  Actor: typeof ActorClass;
  AuditTarget: typeof AuditTargetClass;
  Caller: typeof CallerClass;
}> {
  return {
    AuditLog: (await import('./AuditLog.js')).AuditLog,
    Actor: (await import('./base/Actor.js')).Actor,
    AuditTarget: (await import('./base/AuditTarget.js')).AuditTarget,
    Caller: (await import('./base/Caller.js')).Caller,
  };
}

/** A workspace with an owner and a viewer, the way the workspace service makes one. */
async function team(slug: string): Promise<{ workspaceId: string; deletedId: string }> {
  const { getWorkspaceRepository, getMembershipRepository } = await import('../models/index.js');
  const workspaces = await getWorkspaceRepository();
  const memberships = await getMembershipRepository();
  const ws = await workspaces.create({ name: slug, slug, ownerId: 'u-owner' });
  await memberships.create(ws.id, { userId: 'u-owner', role: 'owner' });
  await memberships.create(ws.id, { userId: 'u-viewer', role: 'viewer' });
  const gone = await workspaces.create({ name: 'Gone', slug: `${slug}-gone`, ownerId: 'u-owner' });
  await memberships.create(gone.id, { userId: 'u-owner', role: 'owner' });
  await workspaces.softDelete(gone.id);
  return { workspaceId: ws.id, deletedId: gone.id };
}

describe('Caller.enter', () => {
  it('a member enters with their role; a non-member or a deleted workspace gives null', async () => {
    const { Actor, Caller } = await classes();
    const { workspaceId, deletedId } = await team('caller-enter');
    const owner = await Caller.enter(workspaceId, Actor.user('u-owner', { ip: '203.0.113.9' }));
    assert.ok(owner);
    assert.deepEqual(
      [owner.workspaceId, owner.userId, owner.role.name],
      [workspaceId, 'u-owner', 'owner'],
    );
    assert.equal(owner.actor.ip, '203.0.113.9');
    assert.equal((await Caller.enter(workspaceId, Actor.user('u-viewer')))?.role.name, 'viewer');
    assert.equal(await Caller.enter(workspaceId, Actor.user('u-stranger')), null);
    assert.equal(await Caller.enter(deletedId, Actor.user('u-owner')), null);
    assert.equal(await Caller.enter('no-such-workspace', Actor.user('u-owner')), null);
  });
});

describe('AuditLog', () => {
  it('records the actor’s address and user agent next to who, what and on what', async () => {
    const { AuditLog, Actor, AuditTarget, Caller } = await classes();
    const { workspaceId } = await team('audit-origin');
    const caller = await Caller.enter(
      workspaceId,
      Actor.user('u-owner', { ip: '203.0.113.7', userAgent: `Browser/1.0\n${'x'.repeat(300)}` }),
    );
    assert.ok(caller);
    const entry = await AuditLog.record(
      caller,
      'integration.mode',
      AuditTarget.integration('i-1'),
      { mode: 'read_write' },
    );
    assert.deepEqual(
      [entry.workspaceId, entry.actorUserId, entry.actorAgentId, entry.action],
      [workspaceId, 'u-owner', null, 'integration.mode'],
    );
    assert.deepEqual([entry.targetType, entry.targetId], ['integration', 'i-1']);
    assert.equal(entry.target?.equals(AuditTarget.integration('i-1')), true);
    assert.equal(entry.ip, '203.0.113.7');
    assert.equal(entry.userAgent?.length, Actor.USER_AGENT_MAX);
    assert.ok(entry.userAgent.startsWith('Browser/1.0x'));
    assert.deepEqual(entry.meta, { mode: 'read_write' });

    const { getAuditLogRepository } = await import('../models/index.js');
    const [stored] = await (await getAuditLogRepository()).list(workspaceId, {}, 1);
    assert.deepEqual(stored, entry.toJSON());
  });

  it('an actor from no request (a job, a test’s plain actor) leaves the origin null', async () => {
    const { AuditLog, Actor, AuditTarget } = await classes();
    const { workspaceId } = await team('audit-plain');
    const plain = await AuditLog.record(
      { workspaceId, actor: { userId: 'u-viewer', agentId: 'k-1' } },
      'mcp.workspace_get',
      AuditTarget.workspace(workspaceId),
    );
    assert.deepEqual(
      [plain.actorUserId, plain.actorAgentId, plain.ip, plain.userAgent, plain.meta],
      ['u-viewer', 'k-1', null, null, {}],
    );
    const system = await AuditLog.record(
      { workspaceId, actor: Actor.system() },
      'sync.run',
      AuditTarget.integration('i-2'),
      { trigger: 'manual' },
    );
    assert.deepEqual([system.actorUserId, system.actorAgentId], ['system', null]);
  });

  it('takes anything Auditable as the target', async () => {
    const { AuditLog, Actor, AuditTarget } = await classes();
    const { workspaceId } = await team('audit-auditable');
    const topic: Auditable = { auditTarget: () => AuditTarget.of('topic', 't-9') };
    const entry = await AuditLog.record(
      { workspaceId, actor: Actor.user('u-owner') },
      'topic.update',
      topic,
      { fields: ['name'] },
    );
    assert.deepEqual([entry.targetType, entry.targetId], ['topic', 't-9']);
  });

  it('lists newest first and finds the newest match by meta', async () => {
    const { AuditLog, Actor, AuditTarget } = await classes();
    const { workspaceId } = await team('audit-read');
    const scope = { workspaceId, actor: Actor.user('u-owner') };
    await AuditLog.record(scope, 'member.invite', AuditTarget.of('invite', 'v-1'), {
      email: 'a@example.test',
    });
    await AuditLog.record(scope, 'member.invite', AuditTarget.of('invite', 'v-2'), {
      email: 'b@example.test',
    });
    const listed = await AuditLog.list(workspaceId, { action: 'member.invite' }, 10);
    assert.deepEqual(
      listed.map((entry) => entry.targetId),
      ['v-2', 'v-1'],
    );
    const found = await AuditLog.findRecent(workspaceId, {
      action: 'member.invite',
      metaEquals: { email: 'a@example.test' },
      since: new Date(Date.now() - 60_000),
    });
    assert.equal(found?.targetId, 'v-1');
    assert.equal(
      await AuditLog.findRecent(workspaceId, {
        action: 'member.invite',
        metaEquals: { email: 'c@example.test' },
        since: new Date(Date.now() - 60_000),
      }),
      null,
    );
  });
});
