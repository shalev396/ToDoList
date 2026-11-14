import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { ForbiddenError } from '../../errors/ForbiddenError.js';
import { MirroredItemError } from '../../errors/MirroredItemError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import type { Role as RoleName } from '../../types/domain.js';
import { Actor } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import { Role } from '../base/Role.js';
import { DashboardPolicy, type DashboardFacts } from './DashboardPolicy.js';
import { IntegrationPolicy } from './IntegrationPolicy.js';
import { ItemPolicy, type ItemAccess, type ItemFacts } from './ItemPolicy.js';
import { WorkspacePolicy } from './WorkspacePolicy.js';

const SETTINGS = { timezone: 'UTC', weekStart: 1 } as unknown as WorkspaceSettings;

function caller(role: RoleName, userId = 'u-me', onlyTopics?: (string | null)[]): Caller {
  return Caller.fromContext(
    { id: 'w-1', role, settings: SETTINGS, ...(onlyTopics === undefined ? {} : { onlyTopics }) },
    Actor.user(userId),
  );
}

const ROLES: RoleName[] = ['viewer', 'editor', 'owner'];

describe('WorkspacePolicy', () => {
  const here = { workspaceId: 'w-1' };
  const policy = WorkspacePolicy.instance;

  it('members read, editors and owners edit, owners manage', () => {
    const table = ROLES.map((role) => [
      role,
      policy.canRead(caller(role), here),
      policy.canEdit(caller(role), here),
      policy.canManage(caller(role), here),
    ]);
    assert.deepEqual(table, [
      ['viewer', true, false, false],
      ['editor', true, true, false],
      ['owner', true, true, true],
    ]);
  });

  it('nothing of another workspace, whatever the role', () => {
    const elsewhere = { workspaceId: 'w-2' };
    assert.ok(!policy.canRead(caller('owner'), elsewhere));
    assert.ok(policy.refusal(caller('owner'), 'manage', elsewhere) instanceof NotFoundError);
  });

  it('refuses with today’s texts', () => {
    assert.equal(
      policy.refusal(caller('viewer'), 'edit', here).message,
      'Only an editor can do this',
    );
    assert.equal(
      policy.refusal(caller('editor'), 'manage', here).message,
      'Only an owner can do this',
    );
    assert.ok(policy.refusal(caller('viewer'), 'read', here) instanceof NotFoundError);
  });

  it('requireRole: the same rule for a standing alone', () => {
    WorkspacePolicy.requireRole('editor', 'edit', 'add pages');
    assert.throws(
      () => {
        WorkspacePolicy.requireRole('viewer', 'edit', 'add pages');
      },
      (error: unknown) =>
        error instanceof ForbiddenError && error.message === 'Only an editor can add pages',
    );
    assert.throws(() => {
      WorkspacePolicy.requireRole('editor', 'manage');
    }, /^ForbiddenError: Only an owner can do this$/);
    assert.ok(WorkspacePolicy.roleMay(Role.viewer, 'read'));
  });
});

describe('IntegrationPolicy', () => {
  const policy = IntegrationPolicy.instance;
  const mine = { workspaceId: 'w-1', ownerUserId: 'u-me' };
  const theirs = { workspaceId: 'w-1', ownerUserId: 'u-other' };

  it('only its owner manages it, whatever their role (a viewer keeps their own)', () => {
    for (const role of ROLES) {
      assert.ok(policy.canManage(caller(role), mine), role);
      assert.ok(policy.canEdit(caller(role), mine), role);
      assert.ok(!policy.canManage(caller(role), theirs), role);
    }
    assert.ok(IntegrationPolicy.isOwn(mine, 'u-me') && !IntegrationPolicy.isOwn(theirs, 'u-me'));
  });

  it('a shared one is readable by the other members, never manageable', () => {
    assert.ok(!policy.canRead(caller('owner'), theirs));
    assert.ok(policy.canRead(caller('viewer'), { ...theirs, shared: true }));
    assert.ok(!policy.canManage(caller('owner'), { ...theirs, shared: true }));
  });

  it('every refusal is 404, workspace owners included', () => {
    for (const action of ['read', 'edit', 'manage'] as const) {
      const refusal = policy.refusal();
      assert.ok(refusal instanceof NotFoundError, action);
      assert.equal(refusal.message, 'Not found');
    }
    assert.ok(!policy.canManage(caller('owner'), { ...mine, workspaceId: 'w-2' }));
  });
});

describe('DashboardPolicy', () => {
  const policy = DashboardPolicy.instance;
  const open: DashboardFacts = { workspaceId: 'w-1', visibility: 'workspace', ownerUserId: 'u-x' };
  const privateMine: DashboardFacts = { ...open, visibility: 'private', ownerUserId: 'u-me' };
  const privateTheirs: DashboardFacts = { ...open, visibility: 'private' };

  it('a private dashboard is its owner’s alone', () => {
    assert.ok(policy.canRead(caller('viewer'), open));
    assert.ok(policy.canRead(caller('viewer'), privateMine));
    assert.ok(!policy.canRead(caller('owner'), privateTheirs));
    assert.ok(policy.refusal(caller('owner'), 'edit', privateTheirs) instanceof NotFoundError);
  });

  it('editors edit what they see; only an owner manages', () => {
    assert.deepEqual(
      ROLES.map((role) => [
        policy.canEdit(caller(role), open),
        policy.canManage(caller(role), open),
      ]),
      [
        [false, false],
        [true, false],
        [true, true],
      ],
    );
    assert.ok(!policy.canEdit(caller('owner'), privateTheirs));
  });
});

describe('ItemPolicy', () => {
  const access: ItemAccess = {
    userId: 'u-me',
    integrations: [
      { id: 'i-mine', provider: 'jira', accountId: 'a-1', ownerUserId: 'u-me' },
      { id: 'i-shared', provider: 'jira', accountId: 'a-1', ownerUserId: 'u-other' },
    ],
    local: 'visible',
  };
  const policy = ItemPolicy.of(access);
  const base: ItemFacts = {
    workspaceId: 'w-1',
    integrationId: null,
    ownerUserId: 'u-me',
    visibility: 'private',
    topicId: 't-1',
    deletedAt: null,
    source: { provider: 'local', url: '' },
  };
  const jira: ItemFacts = {
    ...base,
    integrationId: 'i-shared',
    ownerUserId: null,
    visibility: 'workspace',
    source: { provider: 'jira', url: 'https://example.invalid/browse/A-1' },
  };

  it('reads the items of its access: own and shared integrations, its to-dos, shared to-dos', () => {
    const me = caller('viewer');
    assert.ok(policy.canRead(me, base));
    assert.ok(policy.canRead(me, jira));
    assert.ok(policy.canRead(me, { ...base, ownerUserId: 'u-other', visibility: 'workspace' }));
    assert.ok(!policy.canRead(me, { ...base, ownerUserId: 'u-other' }));
    assert.ok(!policy.canRead(me, { ...jira, integrationId: 'i-unshared' }));
    assert.ok(!policy.canRead(me, { ...base, deletedAt: new Date() }));
    assert.ok(!policy.canRead(me, { ...base, workspaceId: 'w-2' }));
    assert.ok(!policy.canRead(caller('owner', 'u-other'), base));
  });

  it('a calendar push reads only its own to-dos (ruling 12)', () => {
    const own = ItemPolicy.of({ ...access, local: 'own' });
    const shared = { ...base, ownerUserId: 'u-other', visibility: 'workspace' as const };
    assert.ok(!own.canRead(caller('owner'), shared));
    assert.ok(own.canRead(caller('owner'), base));
  });

  it('honours an MCP read’s topic narrowing', () => {
    assert.ok(policy.canRead(caller('viewer', 'u-me', ['t-1']), base));
    assert.ok(!policy.canRead(caller('viewer', 'u-me', ['t-2']), base));
    assert.ok(policy.canRead(caller('viewer', 'u-me', [null]), { ...base, topicId: null }));
  });

  it('editors change local to-dos; a mirrored item is changed at its source (409 with the link)', () => {
    assert.ok(policy.canEdit(caller('editor'), base));
    assert.ok(policy.canManage(caller('editor'), base));
    assert.ok(!policy.canEdit(caller('viewer'), base));
    assert.ok(!policy.canEdit(caller('owner'), jira));
    const mirrored = policy.refusal(caller('owner'), 'edit', jira);
    assert.ok(mirrored instanceof MirroredItemError);
    assert.deepEqual(mirrored.openIn, jira.source);
    assert.equal(
      policy.refusal(caller('viewer'), 'edit', base).message,
      'Only an editor can do this',
    );
    assert.ok(
      policy.refusal(caller('owner'), 'edit', { ...jira, integrationId: 'x' }) instanceof
        NotFoundError,
    );
  });

  it('the filters hold the same rule (copy absorption on lists only)', () => {
    const ws = { id: 'w-1' };
    const list = policy.itemFilter(ws);
    assert.deepEqual(list['$or'], [
      { integrationId: { $in: ['i-mine', 'i-shared'] } },
      { integrationId: null, ownerUserId: 'u-me' },
      { integrationId: null, visibility: 'workspace' },
    ]);
    assert.ok('$nor' in list);
    assert.ok(!('$nor' in policy.itemFilterUnabsorbed(ws)));
    assert.ok(!('$nor' in policy.itemFilter(ws, { 'source.provider': 'jira' })));
    assert.ok('$nor' in policy.itemFilter(ws, { 'source.provider': 'local' }));
    assert.deepEqual(policy.containerFilter({ id: 'w-1', onlyTopics: ['t-1'] }), {
      workspaceId: 'w-1',
      deletedAt: null,
      topicId: { $in: ['t-1'] },
      integrationId: { $in: ['i-mine', 'i-shared'] },
    });
  });

  it('a block that reads two integrations of one account dedups, preferring its first', () => {
    assert.deepEqual(policy.blockScope(['i-shared', 'i-mine']), {
      connectors: ['i-shared', 'i-mine'],
      dedup: ['i-shared', 'i-mine'],
    });
    assert.deepEqual(policy.blockScope(['i-mine']), { connectors: ['i-mine'] });
    assert.deepEqual(policy.blockScope(undefined), { dedup: ['i-mine', 'i-shared'] });
  });
});
