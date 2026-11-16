/**
 * Dashboard.instantiateAll (NewDashboard#writeAll): template pages made at once leave what
 * Dashboard.instantiate leaves for each (the dashboard, its first history entry, an owner's
 * publish, the audit entry), listed by creation in the order given, and refuse what it refuses.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import {
  addDefaultTopics,
  callerFor,
  hasStatus,
  newUser,
} from '../../testing/workspaceFixtures.js';
import { dumpWorkspace } from '../../testing/workspaceDump.js';
import type { Caller } from '../base/Caller.js';
import type * as DashboardModule from './index.js';

let db: TestDatabase;
let classes: typeof DashboardModule;

before(async () => {
  db = await startTestDatabase('todolist_dashboard_instantiate_all');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  classes = await import('./index.js');
});

after(async () => {
  await db.stop();
});

let workspaces = 0;

/** A workspace named `name` with its default topics, as its owner and a viewer. */
async function workspace(
  name: string,
): Promise<{ workspaceId: string; owner: Caller; viewer: Caller; topics: Record<string, string> }> {
  workspaces += 1;
  const models = await import('../../models/index.js');
  // The same people in every workspace: two workspaces' documents then read the same.
  const [owner, viewer] = await Promise.all([newUser('all-owner'), newUser('all-viewer')]);
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name, slug: `all-${String(workspaces)}`, ownerId: owner.id });
  const memberships = await models.getMembershipRepository();
  await memberships.create(created.id, { userId: owner.id, role: 'owner' });
  await memberships.create(created.id, { userId: viewer.id, role: 'viewer' });
  return {
    workspaceId: created.id,
    owner: await callerFor(created.id, owner.id),
    viewer: await callerFor(created.id, viewer.id),
    topics: await addDefaultTopics(created.id),
  };
}

describe('Dashboard.instantiateAll', () => {
  it('leaves what instantiate leaves for each page, listed in the order given', async () => {
    const { Dashboard } = classes;
    const together = await workspace('Pages');
    const alone = await workspace('Pages');
    const inputs = (
      topics: Record<string, string>,
    ): Parameters<typeof Dashboard.instantiate>[1][] => [
      { templateKey: 'dashboard@1', language: 'en' },
      { templateKey: 'work@1', language: 'en', scope: { topicId: topics['work'] } },
      { templateKey: 'project@1', language: 'he', scope: { topicId: topics['personal'] } },
    ];
    const ids = await Dashboard.instantiateAll(together.owner, inputs(together.topics));
    for (const input of inputs(alone.topics)) await Dashboard.instantiate(alone.owner, input);

    const [a, b] = await Promise.all([
      dumpWorkspace(together.workspaceId),
      dumpWorkspace(alone.workspaceId),
    ]);
    for (const collection of ['Dashboards', 'DashboardVersions', 'AuditLogs']) {
      assert.deepEqual(a[collection], b[collection], collection);
    }
    const listed = await Dashboard.listOutlines(together.owner);
    assert.deepEqual(
      listed.map((page) => page.id),
      ids,
    );
    assert.deepEqual(
      listed.map((page) => page.templateKey),
      ['dashboard@1', 'work@1', 'project@1'],
    );
  });

  it('refuses what instantiate refuses, before writing anything', async () => {
    const { Dashboard } = classes;
    const t = await workspace('Refused');
    await assert.rejects(
      Dashboard.instantiateAll(t.viewer, [{ templateKey: 'dashboard@1', language: 'en' }]),
      hasStatus(403),
    );
    await assert.rejects(
      Dashboard.instantiateAll(t.owner, [
        { templateKey: 'dashboard@1', language: 'en' },
        { templateKey: 'work@1', language: 'en', scope: { topicId: 'not-a-topic' } },
      ]),
      hasStatus(400),
    );
    await assert.rejects(
      Dashboard.instantiateAll(t.owner, [{ templateKey: 'no-such@1', language: 'en' }]),
      (error: unknown) => (error as { pointer?: unknown }).pointer === '/templateKey',
    );
    assert.deepEqual(await Dashboard.listOutlines(t.owner), []);
  });
});
