/**
 * What a successful connection test writes on an integration (integrationTest.ts), field by field
 * with conditional updates: the label only while it is still the provider default, and GitHub's
 * `config.boards.enabled` alone, never the whole config. A label or config saved while the test
 * ran is kept.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { IntegrationData } from '../definitions/Integration.js';
import { IntegrationMongoModel, IntegrationRepository } from '../mongoose/Integration.js';

let db: TestDatabase;
let workspaces = 0;

before(async () => {
  db = await startTestDatabase('todolist_integration_connection_test');
});

after(async () => {
  await db.stop();
});

function nextWorkspace(): string {
  workspaces += 1;
  return `w-conn-${String(workspaces)}`;
}

async function github(
  workspaceId: string,
  config: Record<string, unknown>,
): Promise<IntegrationData> {
  return IntegrationRepository.create(workspaceId, {
    connectedBy: 'u-owner',
    provider: 'github',
    accountId: 'octo',
    label: 'octo',
    authMethod: 'fine_grained_pat',
    topicId: 'work',
    config,
  });
}

async function stored(workspaceId: string, id: string): Promise<IntegrationData | null> {
  return IntegrationRepository.findById(workspaceId, id);
}

describe('IntegrationRepository.recordConnectionTest: GitHub boards', () => {
  it('sets config.boards.enabled alone: the rest of boards and of the config stays', async () => {
    const wid = nextWorkspace();
    const config = {
      owner: 'octo',
      ownerType: 'org',
      repos: { include: ['octo/api'] },
      boards: { include: [3], dueField: 'Due' },
    };
    const { id } = await github(wid, config);
    await IntegrationRepository.recordConnectionTest(wid, id, { boardsEnabled: false });
    assert.deepEqual((await stored(wid, id))?.config, {
      ...config,
      boards: { include: [3], dueField: 'Due', enabled: false },
    });
    await IntegrationRepository.recordConnectionTest(wid, id, { boardsEnabled: true });
    assert.deepEqual((await stored(wid, id))?.config['boards'], {
      include: [3],
      dueField: 'Due',
      enabled: true,
    });
  });

  it('creates a missing boards section as {enabled}', async () => {
    const wid = nextWorkspace();
    const { id } = await github(wid, { owner: 'octo', ownerType: 'user' });
    await IntegrationRepository.recordConnectionTest(wid, id, { boardsEnabled: false });
    assert.deepEqual((await stored(wid, id))?.config, {
      owner: 'octo',
      ownerType: 'user',
      boards: { enabled: false },
    });
  });

  it('a config saved after the test read it is kept: only boards.enabled is written', async () => {
    const wid = nextWorkspace();
    const { id } = await github(wid, { owner: 'octo', ownerType: 'org', boards: { include: [3] } });
    // A config PATCH lands while the test runs.
    const saved = {
      owner: 'octo',
      ownerType: 'org',
      repos: { include: ['octo/web'], archived: true },
      boards: { include: [7], dueField: 'Deadline' },
    };
    await IntegrationRepository.update(wid, id, { config: saved });
    await IntegrationRepository.recordConnectionTest(wid, id, { boardsEnabled: false });
    assert.deepEqual((await stored(wid, id))?.config, {
      ...saved,
      boards: { include: [7], dueField: 'Deadline', enabled: false },
    });
  });

  it('never writes boards on another provider, in another workspace, or once deleted', async () => {
    const wid = nextWorkspace();
    const linear = await IntegrationRepository.create(wid, {
      connectedBy: 'u-owner',
      provider: 'linear',
      accountId: 'acme',
      label: 'linear',
      authMethod: 'personal_api_key',
      topicId: 'personal',
      config: {},
    });
    await IntegrationRepository.recordConnectionTest(wid, linear.id, { boardsEnabled: false });
    assert.deepEqual((await stored(wid, linear.id))?.config, {});

    const { id } = await github(wid, { owner: 'octo', ownerType: 'org' });
    await IntegrationRepository.recordConnectionTest(nextWorkspace(), id, { boardsEnabled: false });
    assert.deepEqual((await stored(wid, id))?.config, { owner: 'octo', ownerType: 'org' });

    await IntegrationRepository.softDelete(wid, id);
    await IntegrationRepository.recordConnectionTest(wid, id, { boardsEnabled: false });
    const raw = await IntegrationMongoModel.findById(id).lean();
    assert.deepEqual(raw?.config, { owner: 'octo', ownerType: 'org' });
  });

  it('leaves a boards (or config) that is not an object alone, without failing', async () => {
    for (const config of [
      { owner: 'octo', ownerType: 'org', boards: 'broken' },
      { owner: 'octo', ownerType: 'org', boards: [{ include: [3] }] },
      { owner: 'octo', ownerType: 'org', boards: null },
    ]) {
      const wid = nextWorkspace();
      const { id } = await github(wid, {});
      // Written around the schema: no route stores such a config.
      await IntegrationMongoModel.updateOne({ _id: id }, { $set: { config } });
      await IntegrationRepository.recordConnectionTest(wid, id, { boardsEnabled: false });
      assert.deepEqual((await stored(wid, id))?.config, config);
    }
    const wid = nextWorkspace();
    const { id } = await github(wid, {});
    await IntegrationMongoModel.updateOne(
      { _id: id },
      { $set: { config: ['not', 'an', 'object'] } },
    );
    await IntegrationRepository.recordConnectionTest(wid, id, { boardsEnabled: false });
    assert.deepEqual((await stored(wid, id))?.config, ['not', 'an', 'object']);
  });
});

describe('IntegrationRepository.recordConnectionTest: the label', () => {
  it('replaces the label only while it is still the expected default', async () => {
    const wid = nextWorkspace();
    const { id } = await github(wid, { owner: 'octo', ownerType: 'org' });
    await IntegrationRepository.recordConnectionTest(wid, id, {
      label: { from: 'octo', to: 'Octo Workspace' },
    });
    assert.equal((await stored(wid, id))?.label, 'Octo Workspace');
    // Not the default any more: a second test leaves it.
    await IntegrationRepository.recordConnectionTest(wid, id, {
      label: { from: 'octo', to: 'Other' },
    });
    assert.equal((await stored(wid, id))?.label, 'Octo Workspace');
  });

  it('a label saved after the test read the default is kept', async () => {
    const wid = nextWorkspace();
    const { id } = await github(wid, { owner: 'octo', ownerType: 'org' });
    await IntegrationRepository.update(wid, id, { label: 'Team Octo' });
    await IntegrationRepository.recordConnectionTest(wid, id, {
      label: { from: 'octo', to: 'Octo Workspace' },
      boardsEnabled: true,
    });
    const integration = await stored(wid, id);
    assert.ok(integration);
    assert.equal(integration.label, 'Team Octo');
    assert.deepEqual(
      integration.config['boards'],
      { enabled: true },
      'each field keeps its own condition',
    );
  });

  it('nothing to record: nothing is written', async () => {
    const wid = nextWorkspace();
    const created = await github(wid, { owner: 'octo', ownerType: 'org' });
    await IntegrationRepository.recordConnectionTest(wid, created.id, {});
    assert.deepEqual(
      (await stored(wid, created.id))?.updatedAt.getTime(),
      created.updatedAt.getTime(),
    );
  });
});
