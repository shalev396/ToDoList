/**
 * PERMISSIONS-V2 migration point 17, against a throwaway MongoDB: integrations get their owner
 * from `connectedBy`; blocks get connectors (an old `integrationId in` rule moves into them, other
 * data blocks get the dashboard creator's matching integrations); a changed dashboard's history
 * ends at a reset snapshot; integrations of members who had already left are disconnected
 * (ruling 6); running any of them again changes nothing.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type mongoose from 'mongoose';

import { startTestDatabase, type TestDatabase } from '../testing/testDatabase.js';
import type { Migration } from './types.js';

let db: TestDatabase;
let raw: mongoose.mongo.Db;
let integrationOwners: Migration;
let orphanedIntegrations: Migration;
let blockConnectors: Migration;

const NOW = new Date('2026-11-14T09:00:00Z');
const W = 'w-migrate';

before(async () => {
  db = await startTestDatabase('todolist_migrations_v2');
  ({ integrationOwners } = await import('./integrationOwners.js'));
  ({ orphanedIntegrations } = await import('./orphanedIntegrations.js'));
  ({ blockConnectors } = await import('./blockConnectors.js'));
  const { connection } = (await import('mongoose')).default;
  assert.ok(connection.db);
  raw = connection.db;
});

after(async () => {
  await db.stop();
});

function integration(
  id: string,
  connectedBy: string,
  provider: string,
  extra: Record<string, unknown> = {},
): Record<string, unknown> {
  return {
    _id: id,
    workspaceId: W,
    connectedBy,
    provider,
    accountId: `${id}.example.invalid`,
    label: id,
    authMethod: 'api_token_basic',
    topicId: null,
    status: 'active',
    deletedAt: null,
    createdAt: new Date(`2026-11-0${id.endsWith('2') ? '2' : '1'}T00:00:00Z`),
    ...extra,
  };
}

const where = (...rules: unknown[]): unknown => ({ combinator: 'and', rules });

describe('in the migrations list', () => {
  it('owners, then former members’ integrations, then block connectors, after importance; the Drive clean-up, then the primary calendar, then its read calendar; the old calendar claims answered; orphaned dashboards, then orphaned topics', async () => {
    const { MIGRATIONS } = await import('./index.js');
    assert.deepEqual(
      MIGRATIONS.map(({ id }) => id),
      [
        '2026-11-13-drop-area-scope',
        '2026-11-13-introduce-topics',
        '2026-11-14-add-importance-attribute',
        '2026-11-14-integration-owners',
        '2026-11-14-orphaned-integrations',
        '2026-11-14-block-connectors',
        '2026-11-15-remove-google-drive',
        // After the owners migration: the primary calendar's owner rules read ownerUserId.
        '2026-11-15-primary-calendar',
        // After it: the primary is always a read calendar of its integration.
        '2026-11-15-primary-calendar-read',
        // The push's claims: an old `dashboard` tombstone was answered at its tombstone.
        '2026-11-15-calendar-link-delete-answered',
        // Dashboards, versions and views of workspaces deleted before the cascade removed them.
        '2026-11-15-orphaned-dashboards',
        // And their topics, before the cascade's topics step.
        '2026-11-16-orphaned-topics',
      ],
    );
  });
});

describe('integration owners', () => {
  it('sets ownerUserId from connectedBy, deleted integrations too, once', async () => {
    await raw
      .collection('Integrations')
      .insertMany([
        integration('jira-a', 'u-creator', 'jira'),
        integration('jira-a2', 'u-creator', 'jira'),
        integration('gh-a', 'u-creator', 'github'),
        integration('linear-b', 'u-other', 'linear'),
        integration('gone-a', 'u-creator', 'moodle', { deletedAt: NOW }),
        integration('owned', 'u-x', 'clickup', { ownerUserId: 'u-x' }),
      ]);
    assert.deepEqual(await integrationOwners.run(raw, NOW), { integrations: 5 });
    const owners = await raw
      .collection('Integrations')
      .find({}, { projection: { ownerUserId: 1, connectedBy: 1 } })
      .toArray();
    for (const doc of owners) assert.equal(doc['ownerUserId'], doc['connectedBy'], String(doc._id));
    assert.deepEqual(await integrationOwners.run(raw, NOW), { integrations: 0 });
  });
});

describe('block connectors', () => {
  const blocks = (): unknown[] => [
    // An old D6 connector rule: it becomes the connectors, and leaves the query.
    {
      id: 'blk_rule',
      type: 'list',
      title: 'Tasks',
      viz: { kind: 'list' },
      query: {
        source: 'items',
        where: where({ field: 'integrationId', operator: 'in', value: ['linear-b', 'jira-a'] }),
      },
    },
    // A provider filter: the creator's integrations of that provider, no local to-dos.
    {
      id: 'blk_jira',
      type: 'list',
      title: 'Jira',
      viz: { kind: 'list' },
      query: {
        source: 'items',
        where: where(
          { field: 'source.provider', operator: '=', value: 'jira' },
          { field: 'status', operator: '!=', value: 'done' },
        ),
      },
    },
    // No provider filter: all of the creator's integrations (oldest first), plus local to-dos.
    {
      id: 'blk_all',
      type: 'deadlines',
      title: 'Deadlines',
      viz: { kind: 'deadlines' },
      query: { source: 'items', where: where({ field: 'dueAt', operator: 'notNull' }) },
    },
    // A provider the creator has none of: no field (reads what each viewer may see).
    {
      id: 'blk_notion',
      type: 'list',
      title: 'Notes',
      viz: { kind: 'list' },
      query: {
        source: 'items',
        where: where({ field: 'source.provider', operator: '=', value: 'notion' }),
      },
    },
    // A saved view: its query's provider filter.
    { id: 'blk_view', type: 'list', title: 'View', viz: { kind: 'list' }, savedViewId: 'v-gh' },
    // Not a data block: untouched.
    { id: 'blk_note', type: 'note', title: 'Note', viz: { kind: 'note' }, note: 'Hello' },
    // Already has connectors: untouched.
    {
      id: 'blk_done',
      type: 'list',
      title: 'Done',
      viz: { kind: 'list' },
      query: { source: 'items' },
      connectors: ['local'],
    },
  ];

  it('gives every data block connectors, in the draft and the published copy, and ends history', async () => {
    await raw.collection('Views').insertOne({
      _id: 'v-gh' as never,
      workspaceId: W,
      title: 'GitHub',
      query: {
        source: 'items',
        where: where({ field: 'source.provider', operator: 'in', value: ['github'] }),
      },
      viz: { kind: 'list' },
      visibility: 'workspace',
      ownerUserId: 'u-creator',
    });
    await raw.collection('Dashboards').insertMany([
      {
        _id: 'd-1' as never,
        workspaceId: W,
        ownerUserId: 'u-creator',
        title: 'Main',
        scope: { topicId: null, containerId: null, page: 'topic', groupVar: null },
        vars: {},
        layouts: { lg: [], md: [], sm: [] },
        blocks: blocks(),
        version: 7,
        publishedVersion: 6,
        published: {
          title: 'Main',
          vars: {},
          layouts: { lg: [], md: [], sm: [] },
          blocks: blocks(),
        },
        updatedBy: { userId: 'u-creator', agentId: null },
        deletedAt: null,
      },
      {
        _id: 'd-gone' as never,
        workspaceId: W,
        ownerUserId: 'u-creator',
        title: 'Deleted',
        scope: { topicId: null, containerId: null, page: 'topic', groupVar: null },
        vars: {},
        layouts: { lg: [], md: [], sm: [] },
        blocks: blocks(),
        version: 1,
        publishedVersion: null,
        published: null,
        updatedBy: { userId: 'u-creator', agentId: null },
        deletedAt: NOW,
      },
    ]);
    await raw.collection('DashboardVersions').insertMany([
      { _id: 'v-6' as never, workspaceId: W, dashboardId: 'd-1', version: 6, summary: 'old' },
      { _id: 'v-7' as never, workspaceId: W, dashboardId: 'd-1', version: 7, summary: 'old' },
    ]);

    assert.deepEqual(await blockConnectors.run(raw, NOW), { dashboards: 1, blocks: 8 });

    const stored = await raw.collection('Dashboards').findOne({ _id: 'd-1' as never });
    assert.ok(stored);
    for (const copy of [stored['blocks'], (stored['published'] as { blocks: unknown }).blocks]) {
      const byId = new Map(
        (copy as Record<string, unknown>[]).map((block) => [block['id'] as string, block]),
      );
      assert.deepEqual(byId.get('blk_rule')?.['connectors'], ['linear-b', 'jira-a']);
      assert.deepEqual(byId.get('blk_rule')?.['query'], { source: 'items' });
      assert.deepEqual(byId.get('blk_jira')?.['connectors'], ['jira-a', 'jira-a2']);
      assert.deepEqual(byId.get('blk_all')?.['connectors'], ['jira-a', 'gh-a', 'jira-a2', 'local']);
      assert.equal('connectors' in (byId.get('blk_notion') ?? {}), false, 'absent, never []');
      assert.deepEqual(byId.get('blk_view')?.['connectors'], ['gh-a']);
      assert.equal('connectors' in (byId.get('blk_note') ?? {}), false);
      assert.deepEqual(byId.get('blk_done')?.['connectors'], ['local']);
    }
    // Its history is one reset snapshot of the migrated draft, at the current version.
    const history = await raw
      .collection('DashboardVersions')
      .find({ dashboardId: 'd-1' })
      .toArray();
    assert.equal(history.length, 1);
    assert.deepEqual([history[0]?.['version'], history[0]?.['summary']], [7, 'history-reset']);
    assert.deepEqual((history[0]?.['snapshot'] as { blocks: unknown }).blocks, stored['blocks']);
    // A deleted dashboard is left as it was.
    const gone = await raw.collection('Dashboards').findOne({ _id: 'd-gone' as never });
    assert.deepEqual(gone?.['blocks'], blocks());
  });

  it('changes nothing the second time, even after the creator connects more', async () => {
    await raw
      .collection('Integrations')
      .insertOne(integration('drive-a', 'u-creator', 'notion', { ownerUserId: 'u-creator' }));
    const before = await raw.collection('Dashboards').findOne({ _id: 'd-1' as never });
    assert.deepEqual(await blockConnectors.run(raw, NOW), { dashboards: 0, blocks: 0 });
    const after = await raw.collection('Dashboards').findOne({ _id: 'd-1' as never });
    assert.deepEqual(after, before);
  });
});

describe('integrations of members who left before the upgrade (ruling 6)', () => {
  const O = 'w-orphans';
  const scoped = (doc: Record<string, unknown>): Record<string, unknown> => ({
    ...doc,
    workspaceId: O,
  });

  it('disconnects each live one whose owner is no active member, and only those, once', async () => {
    await raw.collection('Memberships').insertMany([
      {
        _id: 'm-stays' as never,
        workspaceId: O,
        userId: 'u-stays',
        role: 'editor',
        status: 'active',
      },
      {
        _id: 'm-left' as never,
        workspaceId: O,
        userId: 'u-left',
        role: 'editor',
        status: 'revoked',
      },
      // The earlier tests' owners stay members of theirs.
      ...['u-creator', 'u-other', 'u-x'].map((userId) => ({
        _id: `m-${userId}` as never,
        workspaceId: W,
        userId,
        role: 'editor',
        status: 'active',
      })),
      // An active member elsewhere is no member here.
      {
        _id: 'm-else' as never,
        workspaceId: 'w-else',
        userId: 'u-else',
        role: 'owner',
        status: 'active',
      },
    ]);
    await raw
      .collection('Integrations')
      .insertMany([
        scoped(integration('o-stays', 'u-stays', 'jira', { ownerUserId: 'u-stays' })),
        scoped(integration('o-left', 'u-left', 'linear', { ownerUserId: 'u-left' })),
        scoped(integration('o-else', 'u-else', 'github', { ownerUserId: 'u-else' })),
        scoped(
          integration('o-gone', 'u-left', 'moodle', { ownerUserId: 'u-left', deletedAt: NOW }),
        ),
      ]);
    await raw.collection('Credentials').insertMany(
      ['o-stays', 'o-left', 'o-else'].map((id) => ({
        _id: `cred-${id}` as never,
        workspaceId: O,
        integrationId: id,
      })),
    );
    const item = (id: string, integrationId: string): Record<string, unknown> => ({
      _id: id,
      workspaceId: O,
      integrationId,
      title: id,
      deletedAt: null,
    });
    await raw
      .collection('Items')
      .insertMany([
        item('it-stays', 'o-stays'),
        item('it-left', 'o-left'),
        item('it-else', 'o-else'),
      ]);
    await raw
      .collection('Containers')
      .insertMany([item('c-left', 'o-left'), item('c-stays', 'o-stays')]);

    const later = new Date(NOW.getTime() + 60_000);
    assert.deepEqual(await orphanedIntegrations.run(raw, later), {
      integrations: 2,
      credentials: 2,
      items: 2,
      containers: 1,
    });
    const deletedAt = async (collection: string, id: string): Promise<unknown> =>
      (await raw.collection(collection).findOne({ _id: id as never }))?.['deletedAt'];
    assert.equal(await deletedAt('Integrations', 'o-stays'), null);
    for (const id of ['o-left', 'o-else']) {
      assert.deepEqual(await deletedAt('Integrations', id), later, id);
    }
    // A deleted one keeps its own deletion time.
    assert.deepEqual(await deletedAt('Integrations', 'o-gone'), NOW);
    const credentials = await raw.collection('Credentials').find({ workspaceId: O }).toArray();
    assert.deepEqual(
      credentials.map((doc) => String(doc['integrationId'])),
      ['o-stays'],
    );
    assert.equal(await deletedAt('Items', 'it-stays'), null);
    assert.deepEqual(await deletedAt('Items', 'it-left'), later);
    assert.deepEqual(await deletedAt('Containers', 'c-left'), later);
    assert.equal(await deletedAt('Containers', 'c-stays'), null);
    const audit = await raw
      .collection('AuditLogs')
      .find({ workspaceId: O, action: 'integration.disconnect' })
      .toArray();
    assert.deepEqual(audit.map((entry) => String(entry['targetId'])).sort(), ['o-else', 'o-left']);
    assert.ok(audit.every((entry) => entry['actorUserId'] === 'system'));

    assert.deepEqual(await orphanedIntegrations.run(raw, later), {
      integrations: 0,
      credentials: 0,
      items: 0,
      containers: 0,
    });
  });
});
