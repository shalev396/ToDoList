/**
 * DATA.md §5 role matrix over the workspace routes, over HTTP: every route × {viewer, editor,
 * owner, non-member}, each on a fresh workspace. A refused request (403/404) changes nothing.
 * Also: an id from workspace B (an invite, a member) used on A's routes is 404 and leaves B
 * as it was, even for someone who owns both.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';

type Who = 'viewer' | 'editor' | 'owner' | 'stranger';
const PEOPLE = ['viewer', 'editor', 'owner', 'stranger'] as const;

interface Fixture {
  wid: string;
  inviteId: string;
  /** Another member, the subject of the member routes. */
  targetId: string;
}

interface RouteCase {
  route: string;
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE';
  path: (f: Fixture) => string;
  body?: unknown;
  expect: Record<Who, number>;
}

const ws = (f: Fixture): string => `/api/private/workspaces/${f.wid}`;

const MATRIX: RouteCase[] = [
  {
    route: 'GET /workspaces/:wid',
    method: 'GET',
    path: ws,
    expect: { viewer: 200, editor: 200, owner: 200, stranger: 404 },
  },
  {
    route: 'PATCH /workspaces/:wid',
    method: 'PATCH',
    path: ws,
    body: { name: 'Renamed', settings: { weekStart: 'mon' } },
    expect: { viewer: 403, editor: 403, owner: 200, stranger: 404 },
  },
  {
    route: 'DELETE /workspaces/:wid',
    method: 'DELETE',
    path: ws,
    expect: { viewer: 403, editor: 403, owner: 204, stranger: 404 },
  },
  {
    route: 'GET /workspaces/:wid/members',
    method: 'GET',
    path: (f) => `${ws(f)}/members`,
    expect: { viewer: 200, editor: 200, owner: 200, stranger: 404 },
  },
  {
    route: 'PATCH /workspaces/:wid/members/:uid',
    method: 'PATCH',
    path: (f) => `${ws(f)}/members/${f.targetId}`,
    body: { role: 'editor' },
    expect: { viewer: 403, editor: 403, owner: 200, stranger: 404 },
  },
  {
    route: 'DELETE /workspaces/:wid/members/:uid',
    method: 'DELETE',
    path: (f) => `${ws(f)}/members/${f.targetId}`,
    expect: { viewer: 403, editor: 403, owner: 204, stranger: 404 },
  },
  {
    // Anyone may leave, except the last owner.
    route: 'DELETE /workspaces/:wid/members/me',
    method: 'DELETE',
    path: (f) => `${ws(f)}/members/me`,
    expect: { viewer: 204, editor: 204, owner: 409, stranger: 404 },
  },
  {
    route: 'GET /workspaces/:wid/invites',
    method: 'GET',
    path: (f) => `${ws(f)}/invites`,
    expect: { viewer: 403, editor: 403, owner: 200, stranger: 404 },
  },
  {
    route: 'POST /workspaces/:wid/invites',
    method: 'POST',
    path: (f) => `${ws(f)}/invites`,
    body: { email: 'newcomer@example.test', role: 'viewer' },
    expect: { viewer: 403, editor: 403, owner: 201, stranger: 404 },
  },
  {
    route: 'DELETE /workspaces/:wid/invites/:id',
    method: 'DELETE',
    path: (f) => `${ws(f)}/invites/${f.inviteId}`,
    expect: { viewer: 403, editor: 403, owner: 204, stranger: 404 },
  },
];

let api: ApiHarness;
const tokens = {} as Record<Who | 'target', string>;
const userIds = {} as Record<Who | 'target', string>;
let fixtures = 0;

before(async () => {
  api = await startApiHarness('todolist_role_matrix');
  for (const who of [...PEOPLE, 'target'] as const) {
    tokens[who] = (await api.login(`matrix-${who}@example.test`)).token;
    const me = await api.call('GET', '/api/private/me', { token: tokens[who] });
    userIds[who] = (me.body?.['data'] as { id: string }).id;
  }
});

after(async () => {
  await api.stop();
});

/** A fresh workspace: owner, editor, viewer, the target member and a pending invite. */
async function fixture(): Promise<Fixture> {
  const models = await import('../../models/index.js');
  fixtures += 1;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Matrix', slug: `matrix-${String(fixtures)}`, ownerId: userIds.owner });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: userIds.owner, role: 'owner' });
  await memberships.create(workspace.id, { userId: userIds.editor, role: 'editor' });
  await memberships.create(workspace.id, { userId: userIds.viewer, role: 'viewer' });
  await memberships.create(workspace.id, { userId: userIds.target, role: 'viewer' });
  const invite = await (
    await models.getInviteRepository()
  ).create(workspace.id, {
    email: 'pending@example.test',
    role: 'viewer',
    tokenHash: `matrix-hash-${String(fixtures)}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    invitedBy: userIds.owner,
  });
  return { wid: workspace.id, inviteId: invite.id, targetId: userIds.target };
}

/** Everything the routes above can change. */
async function snapshot(f: Fixture): Promise<unknown> {
  const models = await import('../../models/index.js');
  const { WorkspaceMongoModel } = await import('../../models/mongoose/Workspace.js');
  const workspace = await WorkspaceMongoModel.findById(f.wid).lean();
  const members = await (await models.getMembershipRepository()).listMembers(f.wid);
  const invites = await (await models.getInviteRepository()).listForWorkspace(f.wid);
  return {
    name: workspace?.name,
    weekStart: workspace?.settings.weekStart,
    deleted: workspace?.deletedAt ?? null,
    members: members.map((m) => [m.userId, m.role]),
    invites: invites.map((i) => [i.email, i.status]),
  };
}

/** Workspace B: its owner, a member who belongs to B only, and a pending invite. */
async function otherWorkspace(ownerId: string): Promise<Fixture> {
  const models = await import('../../models/index.js');
  fixtures += 1;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Other', slug: `other-${String(fixtures)}`, ownerId });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: ownerId, role: 'owner' });
  const onlyInB = `u-only-in-b-${String(fixtures)}`;
  await memberships.create(workspace.id, { userId: onlyInB, role: 'viewer' });
  const invite = await (
    await models.getInviteRepository()
  ).create(workspace.id, {
    email: 'b-pending@example.test',
    role: 'viewer',
    tokenHash: `other-hash-${String(fixtures)}`,
    expiresAt: new Date(Date.now() + 24 * 60 * 60 * 1000),
    invitedBy: ownerId,
  });
  return { wid: workspace.id, inviteId: invite.id, targetId: onlyInB };
}

interface MismatchCase {
  title: string;
  method: 'PATCH' | 'DELETE';
  /** A request on A's route that names an id from B. */
  path: (a: Fixture, b: Fixture) => string;
  body?: unknown;
}

const MISMATCHED: MismatchCase[] = [
  {
    title: 'using B’s invite id on A’s route (revoking B’s invite)',
    method: 'DELETE',
    path: (a, b) => `${ws(a)}/invites/${b.inviteId}`,
  },
  {
    title: 'PATCHing a uid that is only a member of B',
    method: 'PATCH',
    path: (a, b) => `${ws(a)}/members/${b.targetId}`,
    body: { role: 'editor' },
  },
  {
    title: 'removing a uid that is only a member of B',
    method: 'DELETE',
    path: (a, b) => `${ws(a)}/members/${b.targetId}`,
  },
];

describe('an id from another workspace: 404 through A’s routes, and B stays as it was', () => {
  for (const c of MISMATCHED) {
    // B owned by someone else, and B owned by A's owner too: rights in B don't carry into A's routes.
    for (const bOwner of ['stranger', 'owner'] as const) {
      const as = bOwner === 'owner' ? 'an owner of both A and B' : 'A’s owner (not in B)';
      it(`${c.title}, as ${as} → 404`, async () => {
        const a = await fixture();
        const b = await otherWorkspace(userIds[bOwner]);
        const beforeA = await snapshot(a);
        const beforeB = await snapshot(b);
        const res = await api.call(c.method, c.path(a, b), {
          token: tokens.owner,
          ...(c.body === undefined ? {} : { body: c.body }),
        });
        assert.equal(res.status, 404, res.text);
        assert.deepEqual(await snapshot(b), beforeB, 'B changed');
        assert.deepEqual(await snapshot(a), beforeA, 'A changed');
      });
    }
  }

  it('the same ids work through B’s own routes: the 404s come from the workspace, not the ids', async () => {
    const b = await otherWorkspace(userIds.owner);
    const patched = await api.call('PATCH', `${ws(b)}/members/${b.targetId}`, {
      token: tokens.owner,
      body: { role: 'editor' },
    });
    assert.equal(patched.status, 200, patched.text);
    const revoked = await api.call('DELETE', `${ws(b)}/invites/${b.inviteId}`, {
      token: tokens.owner,
    });
    assert.equal(revoked.status, 204, revoked.text);
  });
});

describe('workspace routes: role matrix (DATA.md §5)', () => {
  for (const c of MATRIX) {
    for (const who of PEOPLE) {
      const expected = c.expect[who];
      it(`${c.route} as ${who} → ${String(expected)}`, async () => {
        const f = await fixture();
        const before = await snapshot(f);
        const res = await api.call(c.method, c.path(f), {
          token: tokens[who],
          ...(c.body === undefined ? {} : { body: c.body }),
        });
        assert.equal(res.status, expected, res.text);
        if (expected === 403 || expected === 404 || expected === 409) {
          assert.deepEqual(await snapshot(f), before, 'a refused request changed something');
        }
      });
    }
  }
});
