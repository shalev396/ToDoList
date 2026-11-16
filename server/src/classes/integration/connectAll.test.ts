/**
 * Integration.connectAllWithKey and Integration.saveCredentials (the demo seed's batches): several
 * connections and credentials at once leave what connectWithKey and saveCredential leave one by
 * one (the integrations, their sealed credentials, their `__run__` states, the audit entries), the
 * integrations listed by creation in the order given; and they refuse what one at a time refuses.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { fakeCredential } from '../../seed/fakeCredentials.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import { dumpWorkspace } from '../../testing/workspaceDump.js';
import {
  addDefaultTopics,
  callerFor,
  hasCode,
  hasStatus,
  newUser,
} from '../../testing/workspaceFixtures.js';
import type { ConnectionInput } from '../../services/integrationConfig.js';
import type { Caller } from '../base/Caller.js';
import type * as IntegrationModule from './index.js';

let db: TestDatabase;
let Integration: typeof IntegrationModule.Integration;

before(async () => {
  db = await startTestDatabase('todolist_classes_connect_all');
  const { syncDB } = await import('../../config/database.js');
  await syncDB();
  ({ Integration } = await import('./index.js'));
});

after(async () => {
  await db.stop();
});

let workspaces = 0;

/** A workspace named `name` with its default topics, as its owner and a viewer. */
async function workspace(name: string): Promise<{ owner: Caller; viewer: Caller }> {
  workspaces += 1;
  const models = await import('../../models/index.js');
  // The same people in every workspace: two workspaces' documents then read the same.
  const [owner, viewer] = await Promise.all([newUser('connect-owner'), newUser('connect-viewer')]);
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name, slug: `connect-${String(workspaces)}`, ownerId: owner.id });
  const memberships = await models.getMembershipRepository();
  await memberships.create(created.id, { userId: owner.id, role: 'owner' });
  await memberships.create(created.id, { userId: viewer.id, role: 'viewer' });
  await addDefaultTopics(created.id);
  return {
    owner: await callerFor(created.id, owner.id),
    viewer: await callerFor(created.id, viewer.id),
  };
}

const CONNECTIONS: ConnectionInput[] = [
  {
    provider: 'jira',
    config: { baseUrl: 'https://example.invalid/jira' },
    label: 'Jira',
    authMethod: 'api_token_basic',
  },
  {
    provider: 'github',
    config: { owner: 'shalev396', ownerType: 'user' },
    label: 'shalev396',
    authMethod: 'fine_grained_pat',
  },
  {
    provider: 'moodle',
    config: { siteUrl: 'https://example.invalid/moodle' },
    label: 'Moodle',
    authMethod: 'moodle_ws_token',
  },
];

describe('Integration.connectAllWithKey and saveCredentials', () => {
  it('leave what one connect and one credential at a time leave, listed in the order given', async () => {
    const together = await workspace('Connect');
    const alone = await workspace('Connect');

    const made = await Integration.connectAllWithKey(together.owner, CONNECTIONS, { demo: true });
    await Integration.saveCredentials(
      together.owner,
      made.map((integration, index) => ({
        integration,
        body: fakeCredential(
          CONNECTIONS[index]?.authMethod as 'api_token_basic',
          `key-${String(index)}`,
        ),
      })),
    );
    for (const [index, connection] of CONNECTIONS.entries()) {
      const one = await Integration.connectWithKey(alone.owner, connection, { demo: true });
      await one.saveCredential(
        alone.owner,
        fakeCredential(connection.authMethod as 'api_token_basic', `key-${String(index)}`),
      );
      // The dump ranks rows by createdAt: one-by-one connects in the same millisecond would tie,
      // where the batch's never do. Let the clock move on before the next one.
      await new Promise((resolve) => setTimeout(resolve, 2));
    }

    const [a, b] = await Promise.all([
      dumpWorkspace(together.owner.workspaceId),
      dumpWorkspace(alone.owner.workspaceId),
    ]);
    for (const collection of ['Integrations', 'Credentials', 'SyncStates', 'AuditLogs']) {
      assert.deepEqual(a[collection], b[collection], collection);
    }
    // GitHub's connect adds its topic rule to the workspace's settings, either way.
    const settingsOf = (dump: typeof a): unknown =>
      (dump['Workspaces']?.[0] as { settings?: unknown } | undefined)?.settings;
    assert.deepEqual(settingsOf(a), settingsOf(b));
    assert.deepEqual(
      (await Integration.listOwn(together.owner)).map((integration) => integration.id),
      made.map((integration) => integration.id),
    );
    assert.deepEqual(
      [...(await Integration.withCredentials(together.owner.workspaceId, made))].sort(),
      made.map((integration) => integration.id).sort(),
    );
  });

  it('refuses the whole batch for a duplicate after the first: nothing of it stays', async () => {
    const t = await workspace('Middle');
    const [jira, github, moodle] = CONNECTIONS;
    assert.ok(jira && github && moodle);
    const [kept] = await Integration.connectAllWithKey(t.owner, [jira], { demo: true });
    const before = await dumpWorkspace(t.owner.workspaceId);
    await assert.rejects(
      Integration.connectAllWithKey(t.owner, [moodle, github, jira], { demo: true }),
      hasCode(409, 'account_already_connected'),
    );
    assert.deepEqual(
      (await Integration.listOwn(t.owner)).map((integration) => integration.id),
      [kept?.id],
    );
    const after = await dumpWorkspace(t.owner.workspaceId);
    // No audit entry and no GitHub topic rule for the ones before the duplicate.
    assert.deepEqual(after['AuditLogs'], before['AuditLogs']);
    assert.deepEqual(after['Workspaces'], before['Workspaces']);
    // They were withdrawn (soft-deleted, as over a cap): only the first connect is live.
    assert.deepEqual(
      (after['Integrations'] ?? [])
        .filter((row) => (row as { deletedAt: unknown }).deletedAt === null)
        .map((row) => (row as { label: unknown }).label),
      ['Jira'],
    );
  });

  it('refuses a viewer, an account already connected, and a secret of the wrong shape', async () => {
    const t = await workspace('Refused');
    await assert.rejects(
      Integration.connectAllWithKey(t.viewer, CONNECTIONS, { demo: true }),
      hasStatus(403),
    );
    const [first] = CONNECTIONS;
    assert.ok(first);
    await Integration.connectAllWithKey(t.owner, [first], { demo: true });
    await assert.rejects(
      Integration.connectAllWithKey(t.owner, CONNECTIONS, { demo: true }),
      hasCode(409, 'account_already_connected'),
    );
    const own = await Integration.listOwn(t.owner);
    assert.equal(own.length, 1, 'the duplicate stopped the batch before anything was added');
    await assert.rejects(
      Integration.saveCredentials(
        t.owner,
        own.map((integration) => ({ integration, body: { nothing: 'here' } })),
      ),
      hasStatus(400),
    );
    assert.deepEqual([...(await Integration.withCredentials(t.owner.workspaceId, own))], []);
  });
});
