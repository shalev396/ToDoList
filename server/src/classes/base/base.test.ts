import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ForbiddenError } from '../../errors/ForbiddenError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import { WorkspacePolicy } from '../policies/WorkspacePolicy.js';
import { Actor } from './Actor.js';
import { AuditTarget } from './AuditTarget.js';
import { Caller, type WorkspaceContext } from './Caller.js';
import { Entity } from './Entity.js';
import { Role } from './Role.js';
import { WorkspaceEntity } from './WorkspaceEntity.js';

const SETTINGS = { timezone: 'UTC', weekStart: 1 } as unknown as WorkspaceSettings;

function context(role: WorkspaceContext['role'], id = 'w-1'): WorkspaceContext {
  return { id, role, settings: SETTINGS };
}

describe('Role', () => {
  it('orders owner > editor > viewer', () => {
    assert.ok(Role.owner.atLeast(Role.editor) && Role.owner.atLeast('viewer'));
    assert.ok(Role.editor.atLeast('editor') && Role.editor.atLeast(Role.viewer));
    assert.ok(!Role.editor.atLeast('owner'));
    assert.ok(!Role.viewer.atLeast(Role.editor) && Role.viewer.atLeast('viewer'));
  });

  it('is a value: one instance per role, frozen, compared by value', () => {
    assert.equal(Role.of('owner'), Role.owner);
    assert.equal(Role.of(Role.editor), Role.editor);
    assert.ok(Role.of('viewer').equals('viewer') && !Role.viewer.equals(Role.owner));
    assert.ok(Object.isFrozen(Role.owner));
    assert.equal(JSON.stringify({ role: Role.editor }), '{"role":"editor"}');
    assert.equal(Role.viewer.toString(), 'viewer');
  });

  it('parses only the three role names', () => {
    assert.equal(Role.parse('editor'), Role.editor);
    for (const bad of ['admin', 'Owner', '', null, 3]) assert.equal(Role.parse(bad), null);
  });

  it('a stored name that is not a role is a clear error, not a broken Role', () => {
    assert.throws(() => Role.of('admin' as unknown as 'owner'), /^Error: Unknown role: "admin"$/);
  });
});

describe('AuditTarget', () => {
  it('is immutable and compared by value', () => {
    const a = AuditTarget.of('integration', 'i-1');
    assert.ok(a.equals(AuditTarget.integration('i-1')));
    assert.ok(!a.equals(AuditTarget.of('integration', 'i-2')));
    assert.ok(!a.equals(AuditTarget.of('item', 'i-1')));
    assert.ok(Object.isFrozen(a));
    assert.deepEqual(a.toJSON(), { type: 'integration', id: 'i-1' });
    assert.deepEqual(AuditTarget.workspace('w-1').toJSON(), { type: 'workspace', id: 'w-1' });
  });

  it('takes a plain {type, id} (an MCP tool’s target)', () => {
    const plain = AuditTarget.from({ type: 'dashboard', id: 'd-1' });
    assert.ok(plain.equals(AuditTarget.of('dashboard', 'd-1')));
    assert.equal(AuditTarget.from(plain), plain);
  });
});

describe('Actor', () => {
  it('is a user, an agent key or the system', () => {
    const user = Actor.user('u-1');
    assert.deepEqual([user.kind, user.userId, user.agentId], ['user', 'u-1', null]);
    const agent = Actor.agent('u-1', 'k-1');
    assert.deepEqual([agent.kind, agent.userId, agent.agentId], ['agent', 'u-1', 'k-1']);
    const system = Actor.system();
    assert.deepEqual([system.kind, system.userId, system.agentId], ['system', 'system', null]);
    assert.ok(system.isSystem && !user.isSystem);
    assert.equal(Actor.system(), system);
  });

  it('keeps the origin, cut to a bounded length and without control characters', () => {
    const actor = Actor.user('u-1', {
      ip: ' 203.0.113.7 ',
      userAgent: `Mozilla/5.0\r\n${'x'.repeat(400)}`,
    });
    assert.equal(actor.ip, '203.0.113.7');
    assert.equal(actor.userAgent?.length, Actor.USER_AGENT_MAX);
    assert.ok(actor.userAgent.startsWith('Mozilla/5.0x'));
    assert.equal(Actor.user('u-1', { ip: 'a'.repeat(100) }).ip?.length, Actor.IP_MAX);
    assert.deepEqual([Actor.user('u-1', { ip: '', userAgent: ' \t' }).ip], [null]);
    assert.equal(Actor.user('u-1').userAgent, null);
  });

  it('reads a request origin, and a plain {userId, agentId} becomes the actor it names', () => {
    assert.deepEqual(Actor.originOf({ ip: '::1', headers: { 'user-agent': 'curl/8' } }), {
      ip: '::1',
      userAgent: 'curl/8',
    });
    assert.equal(Actor.from({ userId: 'u-1', agentId: null }).kind, 'user');
    assert.equal(Actor.from({ userId: 'u-1', agentId: 'k-1' }).kind, 'agent');
    assert.equal(Actor.from({ userId: 'system', agentId: null }).kind, 'system');
    // A loose caller (JavaScript, a test) that leaves agentId out is a user, not an agent.
    const loose = Actor.from({ userId: 'u-1' } as unknown as { userId: string; agentId: null });
    assert.deepEqual([loose.kind, loose.agentId], ['user', null]);
    const actor = Actor.user('u-2');
    assert.equal(Actor.from(actor), actor);
  });

  it('redacts a secret-shaped user agent before the audit log can hold it', () => {
    const token = `ghp_${'a'.repeat(36)}`;
    const actor = Actor.user('u-1', { userAgent: `Agent/1 ${token}` });
    const userAgent = actor.userAgent ?? '';
    assert.ok(!userAgent.includes(token));
    assert.match(userAgent, /^Agent\/1 \[REDACTED:/);
  });

  it('serializes as who acted, never where from', () => {
    const actor = Actor.agent('u-1', 'k-1', { ip: '203.0.113.7', userAgent: 'agent/1' });
    assert.equal(JSON.stringify(actor), '{"userId":"u-1","agentId":"k-1"}');
    assert.ok(Object.isFrozen(actor));
  });
});

interface NoteData {
  id: string;
  workspaceId: string;
  text: string;
}

class Note extends WorkspaceEntity<NoteData> {
  static of(data: NoteData): Note {
    return new Note(data);
  }

  get text(): string {
    return this.data.text;
  }

  check(caller: Caller): void {
    this.assertIn(caller);
  }
}

interface DeepData {
  id: string;
  workspaceId: string;
  text: string;
  tags: string[];
  meta: { at: { n: number } };
}

class Deep extends WorkspaceEntity<DeepData> {
  static of(data: DeepData): Deep {
    return new Deep(data);
  }

  get meta(): Readonly<DeepData['meta']> {
    return this.data.meta;
  }
}

class Other extends Entity<{ id: string }> {
  static of(id: string): Other {
    return new Other({ id });
  }
}

describe('Entity and WorkspaceEntity', () => {
  it('freeze their data at every depth and hand out deep copies', () => {
    const data = { id: 'n-9', workspaceId: 'w-1', text: 'hi', tags: ['a'], meta: { at: { n: 1 } } };
    const deep = Deep.of(data);
    data.tags.push('b');
    data.meta.at.n = 2;
    assert.deepEqual(deep.toJSON(), {
      id: 'n-9',
      workspaceId: 'w-1',
      text: 'hi',
      tags: ['a'],
      meta: { at: { n: 1 } },
    });
    assert.ok(Object.isFrozen(deep.meta) && Object.isFrozen(deep.meta.at));
    const copy = deep.toJSON();
    copy.meta.at.n = 3;
    assert.equal(deep.meta.at.n, 1);
  });

  it('keep their data private and frozen, and copy it out', () => {
    const data = { id: 'n-1', workspaceId: 'w-1', text: 'hi' };
    const note = Note.of(data);
    data.text = 'changed';
    assert.equal(note.text, 'hi');
    assert.deepEqual(note.toJSON(), { id: 'n-1', workspaceId: 'w-1', text: 'hi' });
    const copy = note.toJSON();
    copy.text = 'x';
    assert.equal(note.text, 'hi');
    assert.deepEqual([note.id, note.workspaceId], ['n-1', 'w-1']);
  });

  it('are equal when they are the same kind of thing with the same id', () => {
    const a = Note.of({ id: 'n-1', workspaceId: 'w-1', text: 'a' });
    assert.ok(a.equals(Note.of({ id: 'n-1', workspaceId: 'w-1', text: 'b' })));
    assert.ok(!a.equals(Note.of({ id: 'n-2', workspaceId: 'w-1', text: 'a' })));
    assert.ok(!Other.of('n-1').equals(a));
    assert.ok(!a.equals(null) && !a.equals(undefined));
  });

  it('a caller of another workspace gets 404, never a hint that it exists', () => {
    const note = Note.of({ id: 'n-1', workspaceId: 'w-1', text: 'a' });
    note.check(Caller.fromContext(context('viewer'), Actor.user('u-1')));
    assert.throws(
      () => {
        note.check(Caller.fromContext(context('owner', 'w-2'), Actor.user('u-1')));
      },
      (error: unknown) => error instanceof NotFoundError && error.message === 'Not found',
    );
  });
});

describe('Caller', () => {
  it('is an actor in a workspace with a role', () => {
    const actor = Actor.user('u-1', { ip: '203.0.113.7' });
    const caller = Caller.fromContext(context('editor'), actor);
    assert.deepEqual([caller.workspaceId, caller.userId, caller.role], ['w-1', 'u-1', Role.editor]);
    assert.equal(caller.actor, actor);
    assert.equal(caller.settings, SETTINGS);
    assert.equal(caller.onlyTopics, undefined);
    assert.ok(Object.isFrozen(caller));
  });

  it('hands out its standing as plain data, the keys requireWorkspace always set', () => {
    const caller = Caller.fromContext(context('owner'), Actor.user('u-1'));
    assert.deepEqual(Object.keys(caller.context).sort(), ['id', 'role', 'settings']);
    assert.deepEqual(caller.context, { id: 'w-1', role: 'owner', settings: SETTINGS });
    assert.notEqual(caller.context, caller.context);
    const narrowed = Caller.fromContext(
      { ...context('viewer'), onlyTopics: ['t-1', null] },
      Actor.user('u-1'),
    );
    assert.deepEqual(narrowed.context.onlyTopics, ['t-1', null]);
  });

  it('require: the role refusals the API has always answered', () => {
    const viewer = Caller.fromContext(context('viewer'), Actor.user('u-1'));
    const editor = Caller.fromContext(context('editor'), Actor.user('u-1'));
    editor.require('editor');
    viewer.require(Role.viewer);
    assert.throws(
      () => {
        viewer.require('editor');
      },
      (error: unknown) =>
        error instanceof ForbiddenError &&
        error.statusCode === 403 &&
        error.message === 'Only an editor can do this',
    );
    assert.throws(() => {
      editor.require('owner');
    }, /^ForbiddenError: Only an owner can do this$/);
    assert.throws(() => {
      viewer.require('editor', 'Forbidden');
    }, /^ForbiddenError: Forbidden$/);
  });

  it('authorize: allowed, a role refusal, or 404 for another workspace', () => {
    const owner = Caller.fromContext(context('owner'), Actor.user('u-1'));
    const editor = Caller.fromContext(context('editor'), Actor.user('u-1'));
    const here = { workspaceId: 'w-1' };
    owner.authorize(WorkspacePolicy.instance, 'manage', here);
    assert.ok(editor.can(WorkspacePolicy.instance, 'edit', here));
    assert.ok(!editor.can(WorkspacePolicy.instance, 'manage', here));
    assert.throws(() => {
      editor.authorize(WorkspacePolicy.instance, 'manage', here);
    }, /^ForbiddenError: Only an owner can do this$/);
    assert.throws(() => {
      owner.authorize(WorkspacePolicy.instance, 'read', { workspaceId: 'w-2' });
    }, NotFoundError);
  });
});
