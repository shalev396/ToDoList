import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readdirSync } from 'node:fs';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { CredentialEnvelope } from '../definitions/Credential.js';
import type { SourceRef } from '../definitions/common.js';
import type { ItemData, ItemUpsert } from '../definitions/Item.js';

/**
 * DATA.md §5.3: every repository method takes `workspaceId` first and filters by it. These are
 * the only global methods: no workspace exists yet, or the lookup key is itself global.
 */
const GLOBAL_METHODS = new Set([
  'WorkspaceRepository.create',
  'WorkspaceRepository.findBySlug',
  'WorkspaceRepository.listByIds',
  // The purge's sweep asks which workspaces are live, by id, from the primary.
  'WorkspaceRepository.listLiveIds',
  'MembershipRepository.findForUser',
  'InviteRepository.findByTokenHash',
  'WorkspaceRepository.findByJoinTokenHash',
  'InviteRepository.listPendingForEmail',
  'IntegrationRepository.findByIdForWorker',
  // The sync worker ends the queued run of a disconnected integration: it knows the id only.
  'IntegrationRepository.findIncludingDeletedForWorker',
  'IntegrationRepository.listActiveForDispatch',
  'AgentKeyRepository.findByHash',
  // MCP sign-in grants are found by the hash of a secret, like findByHash: the refresh token
  // (and the two it replaced, for a retried refresh), or the authorization request that made them.
  'AgentKeyRepository.findByRefreshHash',
  'AgentKeyRepository.findBySourceRequest',
  // The refresh endpoint rotates a grant it found by the refresh token's hash: the id is the key.
  'AgentKeyRepository.rotateGrant',
  // The public OAuth callback knows the state only: its hash is the key (like an invite token).
  'OAuthStateRepository.findByStateHash',
  // The nightly purge job (jobs/purge.ts) is maintenance over every workspace.
  'ItemRepository.purgeDeletedBefore',
  'ContainerRepository.purgeDeletedBefore',
  // The same job ends the runs still `running` long after they started.
  'SyncRunRepository.listRunningStartedBefore',
  // And it sweeps the dashboards, versions, views and topics of workspaces that are gone (orphans).
  'DashboardRepository.listWorkspaceIds',
  'DashboardVersionRepository.listWorkspaceIds',
  'ViewRepository.listWorkspaceIds',
  'TopicRepository.listWorkspaceIds',
]);

/** Per-user collections from the Elytra template; DATA.md §3: every collection but Users has a workspaceId. */
const NOT_WORKSPACE_SCOPED = new Set([
  'UserRepository',
  'MediaRepository',
  // The hourly create budget (H5) is per user and provider, across workspaces.
  'CreateQuotaRepository',
  // MCP sign-in, before any workspace is chosen: a client is global, an authorization request
  // names its workspace only once the member approves it.
  'McpClientRepository',
  'McpAuthRequestRepository',
]);

/** Workspaces are the scope itself: there `id` is the workspace id. */
const SCOPE_PARAMETER: Partial<Record<string, string>> = { WorkspaceRepository: 'id' };

type Repository = Record<string, unknown>;

const MONGOOSE_DIR = new URL('../mongoose/', import.meta.url);

/** Every `*Repository` object exported by a module in models/mongoose/. */
async function loadRepositories(): Promise<Map<string, Repository>> {
  const repositories = new Map<string, Repository>();
  const files = readdirSync(MONGOOSE_DIR).filter((file) => file.endsWith('.ts'));
  for (const file of files.sort()) {
    const module = (await import(new URL(file, MONGOOSE_DIR).href)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      if (name.endsWith('Repository') && typeof value === 'object' && value !== null) {
        repositories.set(name, value as Repository);
      }
    }
  }
  return repositories;
}

/** The first parameter's name, from the function's source: `async find(workspaceId, id) {…}`. */
function firstParameterName(fn: (...args: never[]) => unknown): string {
  return /^[^(]*\(\s*([A-Za-z_$][\w$]*)?/.exec(fn.toString())?.[1] ?? '';
}

let db: TestDatabase;
let repositories: Map<string, Repository>;

before(async () => {
  db = await startTestDatabase('todolist_scope_test');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  repositories = await loadRepositories();
});

after(async () => {
  await db.stop();
});

describe('workspace scope: static scan of the repositories', () => {
  it('finds a repository for each of the 18 workspace collections', () => {
    const scoped = [...repositories.keys()].filter((name) => !NOT_WORKSPACE_SCOPED.has(name));
    assert.equal(scoped.length, 18, scoped.join(', '));
  });

  it('every method takes workspaceId first, except the listed global lookups', () => {
    const offenders: string[] = [];
    for (const [name, repository] of repositories) {
      if (NOT_WORKSPACE_SCOPED.has(name)) continue;
      for (const [method, fn] of Object.entries(repository)) {
        if (typeof fn !== 'function' || GLOBAL_METHODS.has(`${name}.${method}`)) continue;
        const first = firstParameterName(fn as (...args: never[]) => unknown);
        const expected = SCOPE_PARAMETER[name] ?? 'workspaceId';
        if (first !== expected) offenders.push(`${name}.${method}(${first})`);
      }
    }
    assert.deepEqual(offenders, []);
  });

  it('every listed global method exists (the allow-list is not stale)', () => {
    for (const qualified of GLOBAL_METHODS) {
      const [name = '', method = ''] = qualified.split('.');
      assert.equal(typeof repositories.get(name)?.[method], 'function', qualified);
    }
  });
});

describe('workspace scope: two workspaces never see each other', () => {
  const future = new Date(Date.now() + 7 * 24 * 60 * 60 * 1000);
  const past = new Date(Date.now() - 60 * 60 * 1000);
  const shared = 'user-shared';

  interface Seeded {
    workspaceId: string;
    owner: string;
    inviteId: string;
    integrationId: string;
    mirroredItemId: string;
    localItemId: string;
    containerId: string;
    runId: string;
    dashboardId: string;
    viewId: string;
    agentKeyId: string;
    linkId: string;
  }

  function envelope(label: string): CredentialEnvelope {
    return {
      alg: 'AES-256-GCM',
      keyProvider: 'aws-kms',
      kmsKeyArn: null,
      keyVersion: 1,
      wrappedDataKey: `FAKE-wrapped-${label}`,
      iv: `FAKE-iv-${label}`,
      authTag: `FAKE-tag-${label}`,
      ciphertext: `FAKE-ciphertext-${label}`,
      aad: `FAKE-aad-${label}`,
    };
  }

  function source(label: string, externalId: string): SourceRef {
    return {
      provider: 'jira',
      accountId: `site-${label}.example.invalid`,
      externalId,
      key: null,
      url: `https://example.invalid/${label}/${externalId}`,
      updatedAtSource: null,
      etag: null,
      hash: `sha1:${label}-${externalId}`,
    };
  }

  async function seed(label: string): Promise<Seeded> {
    const m = await import('../index.js');
    const owner = `user-${label}`;
    const workspace = await (
      await m.getWorkspaceRepository()
    ).create({ name: `Workspace ${label}`, slug: `workspace-${label}`, ownerId: owner });
    const w = workspace.id;
    const memberships = await m.getMembershipRepository();
    await memberships.create(w, { userId: owner, role: 'owner' });
    await memberships.create(w, { userId: shared, role: 'viewer' });
    const invite = await (
      await m.getInviteRepository()
    ).create(w, {
      email: `friend-${label}@example.invalid`,
      role: 'viewer',
      tokenHash: `hash-invite-${label}`,
      expiresAt: future,
      invitedBy: owner,
    });
    const integration = await (
      await m.getIntegrationRepository()
    ).create(w, {
      connectedBy: owner,
      provider: 'jira',
      accountId: `site-${label}.example.invalid`,
      label: `Jira ${label}`,
      authMethod: 'api_token_basic',
      topicId: 'work',
    });
    await (
      await m.getCredentialRepository()
    ).upsertSealed(w, integration.id, {
      ownerUserId: owner,
      kind: 'api_token',
      enc: envelope(label),
    });
    const containers = await m.getContainerRepository();
    await containers.bulkUpsert(w, [
      {
        integrationId: integration.id,
        topicId: 'work',
        type: 'project',
        name: `Project ${label}`,
        source: source(label, 'project-1'),
      },
    ]);
    const [container] = await containers.list(w, {});
    assert.ok(container);
    const items = await m.getItemRepository();
    await items.bulkUpsert(w, [
      {
        integrationId: integration.id,
        containerId: container.id,
        kind: 'issue',
        topicId: 'work',
        title: `Issue ${label}`,
        status: 'open',
        source: source(label, 'issue-1'),
      },
    ]);
    const [mirrored] = await items.aggregate<{ _id: string }>(w, [
      { $match: { 'source.provider': 'jira' } },
    ]);
    assert.ok(mirrored);
    const local = await items.createLocal(w, {
      ownerUserId: owner,
      title: `Todo ${label}`,
      topicId: 'personal',
    });
    await (
      await m.getSyncStateRepository()
    ).upsert(w, integration.id, 'jira:jql', {
      cursor: `cursor-${label}`,
    });
    const run = await (
      await m.getSyncRunRepository()
    ).create(w, { integrationId: integration.id, trigger: 'manual' });
    await (
      await m.getAuditLogRepository()
    ).append(w, {
      actorUserId: shared,
      actorAgentId: `agent-${label}`,
      action: 'mcp.create_todo',
      meta: { idempotencyKey: 'same-key' },
    });
    const dashboard = await (
      await m.getDashboardRepository()
    ).create(w, { ownerUserId: owner, title: `Main ${label}` });
    await (
      await m.getDashboardVersionRepository()
    ).append(w, {
      dashboardId: dashboard.id,
      version: 1,
      patch: [],
      inverse: [],
      actorUserId: owner,
    });
    const view = await (
      await m.getViewRepository()
    ).create(w, { ownerUserId: owner, title: `View ${label}`, query: {}, viz: {} });
    const agentKey = await (
      await m.getAgentKeyRepository()
    ).create(w, {
      userId: shared,
      name: `Agent ${label}`,
      keyHash: `hash-key-${label}`,
      prefix: 'elk_FAKE',
      scopes: ['read'],
    });
    const link = await (
      await m.getCalendarLinkRepository()
    ).upsert(
      w,
      integration.id,
      { calendarId: 'primary', googleEventId: `event-${label}` },
      { itemId: local.id, direction: 'to_google' },
    );
    return {
      workspaceId: w,
      owner,
      inviteId: invite.id,
      integrationId: integration.id,
      mirroredItemId: mirrored._id,
      localItemId: local.id,
      containerId: container.id,
      runId: run.id,
      dashboardId: dashboard.id,
      viewId: view.id,
      agentKeyId: agentKey.id,
      linkId: link.id,
    };
  }

  /** Non-empty, and every row belongs to the workspace. */
  function onlyFrom(workspaceId: string, rows: readonly { workspaceId: string }[]): void {
    assert.ok(rows.length > 0, 'expected rows');
    assert.deepEqual(
      rows.filter((row) => row.workspaceId !== workspaceId),
      [],
    );
  }

  let a: Seeded;
  let b: Seeded;

  before(async () => {
    a = await seed('a');
    b = await seed('b');
  });

  it('reads with A return only A (find, list, count, aggregate)', async () => {
    const m = await import('../index.js');
    const A = a.workspaceId;

    const workspaces = await m.getWorkspaceRepository();
    assert.equal((await workspaces.findById(A))?.id, A);
    assert.deepEqual(
      (await workspaces.listByIds([A])).map((workspace) => workspace.id),
      [A],
    );

    const memberships = await m.getMembershipRepository();
    assert.equal(await memberships.find(A, b.owner), null);
    assert.equal((await memberships.find(A, shared))?.workspaceId, A);
    onlyFrom(A, await memberships.listMembers(A));
    assert.equal(await memberships.countActive(A), 2);
    assert.equal(await memberships.countOwners(A), 1);

    onlyFrom(A, await (await m.getInviteRepository()).listForWorkspace(A));

    const integrations = await m.getIntegrationRepository();
    assert.equal(await integrations.findById(A, b.integrationId), null);
    onlyFrom(A, await integrations.list(A));
    assert.equal(await integrations.countActive(A), 1);

    const credentials = await m.getCredentialRepository();
    assert.equal(await credentials.findSealed(A, b.integrationId), null);
    assert.equal(await credentials.findMeta(A, b.integrationId), null);
    assert.equal((await credentials.findMeta(A, a.integrationId))?.workspaceId, A);

    const items = await m.getItemRepository();
    assert.equal(await items.findById(A, b.localItemId), null);
    assert.equal(await items.findById(A, b.mirroredItemId), null);
    const itemRows = await items.aggregate<{ workspaceId: string }>(A, [
      { $project: { workspaceId: 1 } },
    ]);
    onlyFrom(A, itemRows);
    assert.equal(itemRows.length, 2);

    const containers = await m.getContainerRepository();
    assert.equal(await containers.findById(A, b.containerId), null);
    onlyFrom(A, await containers.list(A, {}));
    onlyFrom(A, await containers.aggregate<{ workspaceId: string }>(A, []));

    const syncStates = await m.getSyncStateRepository();
    assert.equal(await syncStates.get(A, b.integrationId, 'jira:jql'), null);
    assert.equal((await syncStates.get(A, a.integrationId, 'jira:jql'))?.workspaceId, A);

    const syncRuns = await m.getSyncRunRepository();
    assert.equal(await syncRuns.findById(A, b.runId), null);
    assert.deepEqual(await syncRuns.listForIntegration(A, b.integrationId, 10), []);
    onlyFrom(A, await syncRuns.listForIntegration(A, a.integrationId, 10));

    const auditLogs = await m.getAuditLogRepository();
    onlyFrom(A, await auditLogs.list(A, {}, 50));
    const recent = await auditLogs.findRecent(A, {
      action: 'mcp.create_todo',
      metaEquals: { idempotencyKey: 'same-key' },
      since: past,
    });
    assert.equal(recent?.workspaceId, A);
    assert.equal(
      await auditLogs.findRecent(A, {
        action: 'mcp.create_todo',
        actorAgentId: 'agent-b',
        metaEquals: { idempotencyKey: 'same-key' },
        since: past,
      }),
      null,
    );

    const dashboards = await m.getDashboardRepository();
    assert.equal(await dashboards.findById(A, b.dashboardId), null);
    onlyFrom(A, await dashboards.list(A, {}));

    const versions = await m.getDashboardVersionRepository();
    assert.deepEqual(await versions.list(A, b.dashboardId, 10), []);
    assert.equal(await versions.findByVersion(A, b.dashboardId, 1), null);
    onlyFrom(A, await versions.list(A, a.dashboardId, 10));

    const views = await m.getViewRepository();
    assert.equal(await views.findById(A, b.viewId), null);
    onlyFrom(A, await views.list(A));

    const agentKeys = await m.getAgentKeyRepository();
    onlyFrom(A, await agentKeys.listForUser(A, shared));
    assert.equal(await agentKeys.countForUser(A, shared), 1);
    assert.deepEqual(await agentKeys.listForUser(A, b.owner), []);

    const links = await m.getCalendarLinkRepository();
    assert.equal(await links.findByItem(A, b.integrationId, b.localItemId), null);
    assert.deepEqual(await links.listLive(A, b.integrationId), []);
    onlyFrom(A, await links.listLive(A, a.integrationId));
  });

  it('writes with A never touch B', async () => {
    const m = await import('../index.js');
    const A = a.workspaceId;
    const B = b.workspaceId;

    assert.equal(await (await m.getMembershipRepository()).revoke(A, b.owner), false);
    const invites = await m.getInviteRepository();
    assert.equal(await invites.revoke(A, b.inviteId), false);
    assert.equal(await invites.markAccepted(A, b.inviteId, shared), null);
    const integrations = await m.getIntegrationRepository();
    assert.equal(await integrations.update(A, b.integrationId, { label: 'hijacked' }), null);
    assert.equal(await integrations.softDelete(A, b.integrationId), false);
    assert.equal(await (await m.getCredentialRepository()).delete(A, b.integrationId), false);
    const items = await m.getItemRepository();
    assert.equal(await items.updateLocal(A, b.localItemId, { title: 'hijacked' }), null);
    assert.equal(await items.setOverlay(A, b.mirroredItemId, { pinned: true }), null);
    assert.equal(await items.softDelete(A, b.localItemId), false);
    assert.equal(
      await (await m.getSyncRunRepository()).update(A, b.runId, { status: 'failed' }),
      null,
    );
    const dashboards = await m.getDashboardRepository();
    assert.equal(await dashboards.replaceIfVersion(A, b.dashboardId, 1, { title: 'x' }), null);
    assert.equal(await dashboards.softDelete(A, b.dashboardId), false);
    const views = await m.getViewRepository();
    assert.equal(await views.update(A, b.viewId, { title: 'hijacked' }), null);
    assert.equal(await views.delete(A, b.viewId), false);
    assert.equal(await (await m.getAgentKeyRepository()).revoke(A, b.agentKeyId), false);
    assert.equal(
      await (await m.getCalendarLinkRepository()).tombstone(A, b.linkId, 'dashboard'),
      null,
    );
    assert.equal(
      await (await m.getDashboardVersionRepository()).pruneKeeping(A, b.dashboardId, 0, []),
      0,
    );

    // B is exactly as seeded.
    assert.equal((await (await m.getMembershipRepository()).find(B, b.owner))?.status, 'active');
    assert.equal((await invites.listForWorkspace(B))[0]?.status, 'pending');
    assert.equal((await integrations.findById(B, b.integrationId))?.label, 'Jira b');
    assert.ok(await (await m.getCredentialRepository()).findMeta(B, b.integrationId));
    assert.equal((await items.findById(B, b.localItemId))?.title, 'Todo b');
    assert.equal((await items.findById(B, b.mirroredItemId))?.overlay.pinned, null);
    assert.equal((await (await m.getSyncRunRepository()).findById(B, b.runId))?.status, 'queued');
    assert.equal((await dashboards.findById(B, b.dashboardId))?.version, 1);
    assert.equal((await views.findById(B, b.viewId))?.title, 'View b');
    assert.equal(
      (await (await m.getAgentKeyRepository()).findByHash('hash-key-b'))?.revokedAt,
      null,
    );
    assert.equal(
      (await (await m.getCalendarLinkRepository()).listLive(B, b.integrationId)).length,
      1,
    );
    assert.equal(
      (await (await m.getDashboardVersionRepository()).list(B, b.dashboardId, 10)).length,
      1,
    );
  });

  it('an identical source in A and B stays apart on bulkUpsert; touch and update are scoped', async () => {
    const m = await import('../index.js');
    const A = a.workspaceId;
    const B = b.workspaceId;
    const items = await m.getItemRepository();
    const twin = (integrationId: string, title: string, hash: string): ItemUpsert => ({
      integrationId,
      kind: 'issue',
      topicId: 'work',
      title,
      status: 'open',
      source: {
        provider: 'jira',
        accountId: 'site-twin.example.invalid',
        externalId: 'twin-1',
        key: null,
        url: 'https://example.invalid/twin-1',
        updatedAtSource: null,
        etag: null,
        hash,
      },
    });
    await items.bulkUpsert(A, [twin(a.integrationId, 'Twin', 'sha1:one')]);
    await items.bulkUpsert(B, [twin(b.integrationId, 'Twin', 'sha1:one')]);
    const find = async (workspaceId: string): Promise<ItemData> => {
      const [row] = await items.aggregate<{ _id: string }>(workspaceId, [
        { $match: { 'source.externalId': 'twin-1' } },
      ]);
      assert.ok(row);
      const item = await items.findById(workspaceId, row._id);
      assert.ok(item);
      return item;
    };
    const twinB = await find(B);

    // Changed in A: B's copy keeps its title, hash, lastSeenAt and updatedAt.
    // (`closed`: items bulkUpsert also counts items it closes, T3.2 fix round 1.)
    assert.deepEqual(await items.bulkUpsert(A, [twin(a.integrationId, 'Changed', 'sha1:two')]), {
      inserted: 0,
      updated: 1,
      unchanged: 0,
      closed: 0,
    });
    assert.equal((await find(A)).title, 'Changed');
    assert.deepEqual(await find(B), twinB);
    // Unchanged in A: only A's lastSeenAt moves.
    assert.equal(
      (await items.bulkUpsert(A, [twin(a.integrationId, 'Changed', 'sha1:two')])).unchanged,
      1,
    );
    assert.deepEqual(await find(B), twinB);

    // AgentKey.touch(A, <B's key id>) leaves B's key alone.
    const agentKeys = await m.getAgentKeyRepository();
    await agentKeys.touch(A, b.agentKeyId, new Date());
    assert.equal((await agentKeys.findByHash('hash-key-b'))?.lastUsedAt, null);

    // Membership.update(A, ...) changes A's membership of the shared user, not B's.
    const memberships = await m.getMembershipRepository();
    assert.equal((await memberships.update(A, shared, { role: 'editor' }))?.role, 'editor');
    assert.equal((await memberships.find(B, shared))?.role, 'viewer');
    assert.equal(await memberships.update(A, b.owner, { role: 'viewer' }), null);
    assert.equal((await memberships.find(B, b.owner))?.role, 'owner');
  });

  it('workspace-wide deletes with A (workspace deletion) never touch B', async () => {
    const m = await import('../index.js');
    const A = a.workspaceId;
    const B = b.workspaceId;

    const credentials = await m.getCredentialRepository();
    const integrations = await m.getIntegrationRepository();
    const items = await m.getItemRepository();
    const containers = await m.getContainerRepository();
    const agentKeys = await m.getAgentKeyRepository();
    assert.equal(await credentials.deleteForWorkspace(A), 1);
    assert.equal(await integrations.softDeleteForWorkspace(A), 1);
    // Earlier tests in this suite may add items to A, so count what is live there first.
    const [live] = await items.aggregate<{ n: number }>(A, [
      { $match: { deletedAt: null } },
      { $count: 'n' },
    ]);
    assert.equal(await items.softDeleteForWorkspace(A), live?.n ?? 0);
    assert.equal(await containers.softDeleteForWorkspace(A), 1);
    assert.equal(await agentKeys.revokeForUser(A, shared), 1);
    await credentials.touch(A, b.integrationId, new Date(0));

    assert.equal(await items.findById(A, a.localItemId), null);
    assert.ok(await credentials.findMeta(B, b.integrationId));
    assert.equal((await credentials.findMeta(B, b.integrationId))?.lastUsedAt, null);
    assert.equal((await integrations.findById(B, b.integrationId))?.label, 'Jira b');
    assert.equal((await items.findById(B, b.localItemId))?.title, 'Todo b');
    assert.ok(await items.findById(B, b.mirroredItemId));
    assert.equal((await containers.findById(B, b.containerId))?.name, 'Project b');
    assert.equal(await agentKeys.countForUser(B, shared), 1);
  });
});
