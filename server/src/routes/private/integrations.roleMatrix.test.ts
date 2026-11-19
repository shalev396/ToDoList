/**
 * DATA.md §5 role matrix over the integration and sync routes, over HTTP, as PERMISSIONS-V2 has
 * it: every route × {viewer, editor, owner, non-member}, each on a fresh workspace; a refused
 * request (403/404) changes nothing.
 * - Editors and owners connect their own integrations; viewers are refused (403, ruling 9).
 * - Every route on one integration is its owner's alone, whatever their role: everyone else gets
 *   404, the workspace owner too (rulings 1, 2, 10, 20, 23c). The matrix runs with the integration
 *   owned by the workspace owner, by an editor, and by a viewer (an editor moved down).
 * - An integration id from workspace B used on A's routes is 404 and leaves both as they were,
 *   even for someone who owns both (Review focus 2).
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { getAdapter, registerAdapter, unregisterAdapter } from '../../sync/registry.js';
import type { ProviderAdapter } from '../../sync/types.js';
import { startApiHarness, type ApiHarness } from '../../testing/apiHarness.js';
import { createFakeAdapter } from '../../testing/fakeAdapter.js';
import { forceSyncModeForTests } from '../../config/testSwitches.js';

forceSyncModeForTests('fixtures');

type Who = 'viewer' | 'editor' | 'owner' | 'stranger';
const PEOPLE = ['viewer', 'editor', 'owner', 'stranger'] as const;

const JIRA = { email: 'matrix-jira@example.test', token: 'ATATT3xFAKE0123456789matrixabcdef' };

interface Fixture {
  wid: string;
  /** A Jira integration with a saved credential. */
  iid: string;
  /** One of its containers. */
  cid: string;
}

interface RouteCase {
  route: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  path: (f: Fixture) => string;
  body?: unknown;
  expect: Record<Who, number>;
}

const ws = (f: Fixture): string => `/api/private/workspaces/${f.wid}`;
const one = (f: Fixture): string => `${ws(f)}/integrations/${f.iid}`;

type Member = Exclude<Who, 'stranger'>;

/** The status a route on one integration answers: its owner succeeds, everyone else 404. */
function own(owner: Member, ok: number): Record<Who, number> {
  return {
    viewer: owner === 'viewer' ? ok : 404,
    editor: owner === 'editor' ? ok : 404,
    owner: owner === 'owner' ? ok : 404,
    stranger: 404,
  };
}

/** The routes, with the integration in the fixture owned by `owner`. */
function matrix(owner: Member): RouteCase[] {
  return [
    {
      route: 'GET /workspaces/:wid/integrations',
      method: 'GET',
      path: (f) => `${ws(f)}/integrations`,
      expect: { viewer: 200, editor: 200, owner: 200, stranger: 404 },
    },
    {
      route: 'POST /workspaces/:wid/integrations',
      method: 'POST',
      path: (f) => `${ws(f)}/integrations`,
      body: { provider: 'linear', config: {} },
      expect: { viewer: 403, editor: 201, owner: 201, stranger: 404 },
    },
    {
      route: 'PUT /workspaces/:wid/integrations/:iid/credential',
      method: 'PUT',
      path: (f) => `${one(f)}/credential`,
      body: JIRA,
      expect: own(owner, 204),
    },
    {
      route: 'POST /workspaces/:wid/integrations/:iid/test',
      method: 'POST',
      path: (f) => `${one(f)}/test`,
      expect: own(owner, 200),
    },
    {
      route: 'GET /workspaces/:wid/integrations/:iid/config',
      method: 'GET',
      path: (f) => `${one(f)}/config`,
      expect: own(owner, 200),
    },
    {
      route: 'PATCH /workspaces/:wid/integrations/:iid',
      method: 'PATCH',
      path: one,
      body: { label: 'Renamed', topicId: null },
      expect: own(owner, 200),
    },
    {
      // Workspace owners only (403 below), then the integration's owner (404 for the rest).
      route: 'PUT /workspaces/:wid/integrations/:iid/containers/:cid/file-under',
      method: 'PUT',
      path: (f) => `${one(f)}/containers/${f.cid}/file-under`,
      body: { topicId: null },
      expect: {
        viewer: 403,
        editor: 403,
        owner: owner === 'owner' ? 200 : 404,
        stranger: 404,
      },
    },
    {
      route: 'POST /workspaces/:wid/integrations/:iid/stop-sharing',
      method: 'POST',
      path: (f) => `${one(f)}/stop-sharing`,
      expect: own(owner, 200),
    },
    {
      route: 'DELETE /workspaces/:wid/integrations/:iid',
      method: 'DELETE',
      path: one,
      expect: own(owner, 204),
    },
    {
      // Each member's own integrations only: possibly none (202 with no run).
      route: 'POST /workspaces/:wid/sync',
      method: 'POST',
      path: (f) => `${ws(f)}/sync`,
      expect: { viewer: 202, editor: 202, owner: 202, stranger: 404 },
    },
    {
      route: 'POST /workspaces/:wid/integrations/:iid/sync',
      method: 'POST',
      path: (f) => `${one(f)}/sync`,
      expect: own(owner, 202),
    },
    {
      route: 'GET /workspaces/:wid/sync-runs',
      method: 'GET',
      path: (f) => `${ws(f)}/sync-runs`,
      expect: { viewer: 200, editor: 200, owner: 200, stranger: 404 },
    },
  ];
}

let api: ApiHarness;
const tokens = {} as Record<Who, string>;
const userIds = {} as Record<Who, string>;
let fixtures = 0;
let original: ProviderAdapter | null = null;

before(async () => {
  api = await startApiHarness('todolist_integrations_matrix');
  for (const who of PEOPLE) {
    tokens[who] = (await api.login(`int-matrix-${who}@example.test`)).token;
    const me = await api.call('GET', '/api/private/me', { token: tokens[who] });
    userIds[who] = (me.body?.['data'] as { id: string }).id;
  }
  // Jira syncs replay the fake adapter's fixtures, so in-process runs end quietly.
  original = getAdapter('jira');
  unregisterAdapter('jira');
  registerAdapter({ ...createFakeAdapter().adapter, provider: 'jira' });
});

after(async () => {
  await settled();
  unregisterAdapter('jira');
  if (original !== null) registerAdapter(original);
  await api.stop();
});

/** No run queued or running: the in-process syncs are done. */
async function settled(): Promise<void> {
  const { SyncRunMongoModel } = await import('../../models/mongoose/SyncRun.js');
  for (let attempt = 0; attempt < 500; attempt += 1) {
    if (
      (await SyncRunMongoModel.countDocuments({ status: { $in: ['queued', 'running'] } })) === 0
    ) {
      await new Promise((resolve) => setTimeout(resolve, 50));
      return;
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error('sync runs did not finish');
}

/**
 * A workspace owned by `ownerId`, with a Jira integration and its credential, owned by
 * `integrationOwner` (default: the workspace's owner).
 */
async function workspace(
  ownerId: string,
  members: boolean,
  integrationOwner: string = ownerId,
): Promise<Fixture> {
  const models = await import('../../models/index.js');
  const { Credential } = await import('../../classes/integration/Credential.js');
  fixtures += 1;
  const workspace = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Matrix', slug: `int-matrix-${String(fixtures)}`, ownerId });
  const memberships = await models.getMembershipRepository();
  await memberships.create(workspace.id, { userId: ownerId, role: 'owner' });
  if (members) {
    await memberships.create(workspace.id, { userId: userIds.editor, role: 'editor' });
    await memberships.create(workspace.id, { userId: userIds.viewer, role: 'viewer' });
  }
  const integration = await (
    await models.getIntegrationRepository()
  ).create(workspace.id, {
    connectedBy: integrationOwner,
    ownerUserId: integrationOwner,
    provider: 'jira',
    accountId: `site-${String(fixtures)}.atlassian.net`,
    label: 'Jira',
    authMethod: 'api_token_basic',
    topicId: 'work',
    config: { baseUrl: `https://site-${String(fixtures)}.atlassian.net` },
  });
  await Credential.seal({
    workspaceId: workspace.id,
    integrationId: integration.id,
    provider: 'jira',
    ownerUserId: integrationOwner,
    kind: 'api_token_basic',
    secret: JIRA,
  });
  await (
    await models.getContainerRepository()
  ).bulkUpsert(workspace.id, [
    {
      integrationId: integration.id,
      topicId: 'work',
      type: 'project',
      name: 'Board',
      source: {
        provider: 'jira',
        accountId: `site-${String(fixtures)}.atlassian.net`,
        externalId: 'c-1',
        key: null,
        url: 'https://example.test/c-1',
        updatedAtSource: null,
        etag: null,
        hash: null,
      },
    },
  ]);
  const [container] = await (
    await models.getContainerRepository()
  ).list(workspace.id, { integrationId: integration.id });
  return { wid: workspace.id, iid: integration.id, cid: container?.id ?? '' };
}

/** Everything the routes above can change in a workspace. */
async function snapshot(wid: string): Promise<unknown> {
  const { IntegrationMongoModel } = await import('../../models/mongoose/Integration.js');
  const { CredentialMongoModel } = await import('../../models/mongoose/Credential.js');
  const { SyncRunMongoModel } = await import('../../models/mongoose/SyncRun.js');
  const { WorkspaceMongoModel } = await import('../../models/mongoose/Workspace.js');
  const integrations = await IntegrationMongoModel.find({ workspaceId: wid })
    .sort({ createdAt: 1 })
    .lean();
  const credentials = await CredentialMongoModel.find({ workspaceId: wid }).select('+enc').lean();
  return {
    integrations: integrations.map((i) => [
      i._id,
      i.label,
      i.topicId,
      i.status,
      i.accountId,
      i.config,
      i.deletedAt,
      i.lastError,
    ]),
    credentials: credentials.map((c) => [c._id, c.enc.ciphertext, c.rotatedAt, c.lastUsedAt]),
    runs: await SyncRunMongoModel.countDocuments({ workspaceId: wid }),
    rules: (await WorkspaceMongoModel.findById(wid).lean())?.settings.topicRules,
  };
}

for (const integrationOwner of ['owner', 'editor', 'viewer'] as const) {
  describe(`integration and sync routes: role matrix, the ${integrationOwner}'s integration`, () => {
    for (const c of matrix(integrationOwner)) {
      for (const who of PEOPLE) {
        const expected = c.expect[who];
        it(`${c.route} as ${who} → ${String(expected)}`, async () => {
          const f = await workspace(userIds.owner, true, userIds[integrationOwner]);
          const before = await snapshot(f.wid);
          const res = await api.call(c.method, c.path(f), {
            token: tokens[who],
            ...(c.body === undefined ? {} : { body: c.body }),
          });
          assert.equal(res.status, expected, res.text);
          await settled();
          if (expected === 403 || expected === 404) {
            assert.deepEqual(await snapshot(f.wid), before, 'a refused request changed something');
          }
        });
      }
    }
  });
}

interface MismatchCase {
  title: string;
  method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';
  /** A request on A's routes that names B's integration. */
  path: (a: Fixture, b: Fixture) => string;
  body?: unknown;
}

const MISMATCHED: MismatchCase[] = [
  {
    title: 'saving a credential for B’s integration',
    method: 'PUT',
    path: (a, b) => `${ws(a)}/integrations/${b.iid}/credential`,
    body: JIRA,
  },
  {
    title: 'testing B’s integration',
    method: 'POST',
    path: (a, b) => `${ws(a)}/integrations/${b.iid}/test`,
  },
  {
    title: 'reading B’s integration’s config',
    method: 'GET',
    path: (a, b) => `${ws(a)}/integrations/${b.iid}/config`,
  },
  {
    title: 'renaming B’s integration',
    method: 'PATCH',
    path: (a, b) => `${ws(a)}/integrations/${b.iid}`,
    body: { label: 'Hijacked' },
  },
  {
    title: 'disconnecting B’s integration',
    method: 'DELETE',
    path: (a, b) => `${ws(a)}/integrations/${b.iid}`,
  },
  {
    title: 'syncing B’s integration',
    method: 'POST',
    path: (a, b) => `${ws(a)}/integrations/${b.iid}/sync`,
  },
  {
    title: 'listing B’s integration’s runs',
    method: 'GET',
    path: (a, b) => `${ws(a)}/sync-runs?integrationId=${b.iid}`,
  },
  {
    title: 'stopping B’s integration from sharing',
    method: 'POST',
    path: (a, b) => `${ws(a)}/integrations/${b.iid}/stop-sharing`,
  },
];

describe('an integration id from another workspace: 404 through A’s routes; A and B unchanged', () => {
  for (const c of MISMATCHED) {
    for (const bOwner of ['stranger', 'owner'] as const) {
      const as = bOwner === 'owner' ? 'an owner of both A and B' : 'A’s owner (not in B)';
      it(`${c.title}, as ${as} → 404`, async () => {
        const a = await workspace(userIds.owner, true);
        const b = await workspace(userIds[bOwner], false);
        const beforeA = await snapshot(a.wid);
        const beforeB = await snapshot(b.wid);
        const res = await api.call(c.method, c.path(a, b), {
          token: tokens.owner,
          ...(c.body === undefined ? {} : { body: c.body }),
        });
        assert.equal(res.status, 404, res.text);
        await settled();
        assert.deepEqual(await snapshot(b.wid), beforeB, 'B changed');
        assert.deepEqual(await snapshot(a.wid), beforeA, 'A changed');
      });
    }
  }

  it('the same id works through B’s own routes: the 404s come from the workspace', async () => {
    const b = await workspace(userIds.owner, false);
    const base = `/api/private/workspaces/${b.wid}/integrations/${b.iid}`;
    const patched = await api.call('PATCH', base, { token: tokens.owner, body: { label: 'B' } });
    assert.equal(patched.status, 200, patched.text);
    const synced = await api.call('POST', `${base}/sync`, { token: tokens.owner });
    assert.equal(synced.status, 202, synced.text);
    await settled();
  });
});
