/**
 * Refiling (File under): stored containers and items move to the topic the workspace's rules and
 * the connection's default give them, in place, without a provider call.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { SourceRef } from '../../models/definitions/common.js';
import type { Provider } from '../../types/domain.js';
import type * as Classes from './index.js';
import type * as IntegrationClasses from '../integration/index.js';
import type * as Models from '../../models/index.js';

let db: TestDatabase;
let Refiling: typeof Classes.Refiling;
let Container: typeof Classes.Container;
let Integration: typeof IntegrationClasses.Integration;
let models: typeof Models;
let workspaces = 0;

before(async () => {
  db = await startTestDatabase('todolist_refiling_test');
  ({ Refiling, Container } = await import('./index.js'));
  ({ Integration } = await import('../integration/index.js'));
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

function source(provider: Provider, externalId: string, key: string | null = null): SourceRef {
  return {
    provider,
    accountId: 'acct',
    externalId,
    key,
    url: `https://example.test/${externalId}`,
    updatedAtSource: null,
    etag: null,
    hash: null,
  };
}

interface Fixture {
  wid: string;
  work: string;
  personal: string;
  studies: string;
}

async function fixture(): Promise<Fixture> {
  workspaces += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Refile', slug: `refile-${String(workspaces)}`, ownerId: 'u-owner' });
  const topics = await models.getTopicRepository();
  const make = async (slug: string, order: number): Promise<string> =>
    (await topics.create(created.id, { name: slug, slug, order })).id;
  return {
    wid: created.id,
    work: await make('work', 0),
    personal: await make('personal', 1),
    studies: await make('studies', 2),
  };
}

async function connect(
  f: Fixture,
  provider: Provider,
  topicId: string | null,
  accountId = 'acct',
): Promise<IntegrationClasses.Integration> {
  const data = await (
    await models.getIntegrationRepository()
  ).create(f.wid, {
    connectedBy: 'u-owner',
    ownerUserId: 'u-owner',
    provider,
    accountId,
    label: provider,
    authMethod: provider === 'github' ? 'classic_pat' : 'oauth',
    topicId,
  });
  return Integration.from(data);
}

async function setRules(
  f: Fixture,
  topicRules: { match: string; topicId: string }[],
): Promise<void> {
  await (await models.getWorkspaceRepository()).update(f.wid, { settings: { topicRules } });
}

async function addContainer(
  f: Fixture,
  integration: IntegrationClasses.Integration,
  name: string,
  topicId: string | null,
  key: string | null = null,
  externalId = name,
): Promise<string> {
  const provider = integration.provider;
  await (
    await models.getContainerRepository()
  ).bulkUpsert(f.wid, [
    {
      integrationId: integration.id,
      topicId,
      type: provider === 'github' ? 'project' : 'calendar',
      name,
      source: source(provider, externalId, key),
    },
  ]);
  const found = await (
    await models.getContainerRepository()
  ).list(f.wid, { integrationId: integration.id });
  const row = found.find((c) => c.source.externalId === externalId);
  assert.ok(row);
  return row.id;
}

async function addItem(
  f: Fixture,
  integration: IntegrationClasses.Integration,
  containerId: string | null,
  title: string,
  topicId: string | null,
): Promise<string> {
  const items = await models.getItemRepository();
  await items.bulkUpsert(f.wid, [
    {
      integrationId: integration.id,
      containerId,
      kind: 'event',
      topicId,
      title,
      status: 'open',
      source: source(integration.provider, `item-${title}`),
    },
  ]);
  const { ItemMongoModel } = await import('../../models/mongoose/Item.js');
  const found = await ItemMongoModel.findOne({
    workspaceId: f.wid,
    integrationId: integration.id,
    title,
  }).lean();
  assert.ok(found, title);
  return found._id;
}

async function topicOfItem(id: string): Promise<string | null | undefined> {
  const { ItemMongoModel } = await import('../../models/mongoose/Item.js');
  return (await ItemMongoModel.findById(id).lean())?.topicId;
}

async function topicOfContainer(f: Fixture, id: string): Promise<string | null | undefined> {
  return (await (await models.getContainerRepository()).findById(f.wid, id))?.topicId;
}

describe('Refiling.integration', () => {
  it('moves a connection to its new topic, container by container, and keeps overlays', async () => {
    const f = await fixture();
    const google = await connect(f, 'google_calendar', f.personal);
    const calA = await addContainer(f, google, 'Personal', f.personal);
    const calB = await addContainer(f, google, 'braude', f.personal);
    const a = await addItem(f, google, calA, 'a', f.personal);
    const b = await addItem(f, google, calB, 'b', f.personal);
    const loose = await addItem(f, google, null, 'loose', f.personal);
    const overridden = await addItem(f, google, calA, 'over', f.personal);
    await (
      await models.getItemRepository()
    ).setOverlay(f.wid, overridden, {
      topicOverride: f.studies,
    });

    await (await models.getIntegrationRepository()).update(f.wid, google.id, { topicId: f.work });
    const stored = await (await models.getIntegrationRepository()).findById(f.wid, google.id);
    assert.ok(stored);
    const refreshed = Integration.from(stored);
    const counts = await Refiling.integration(refreshed);

    assert.deepEqual(counts, { containers: 2, items: 4 });
    for (const id of [a, b, loose, overridden]) assert.equal(await topicOfItem(id), f.work);
    for (const id of [calA, calB]) assert.equal(await topicOfContainer(f, id), f.work);
    const kept = await (await models.getItemRepository()).findById(f.wid, overridden);
    assert.equal(kept?.overlay.topicOverride, f.studies);
  });

  it('a name rule beats the default; removing it returns the container to the default', async () => {
    const f = await fixture();
    const google = await connect(f, 'google_calendar', f.personal);
    const plain = await addContainer(f, google, 'Personal', f.personal);
    const braude = await addContainer(f, google, 'braude', f.personal);
    const item = await addItem(f, google, braude, 'lecture', f.personal);

    await setRules(f, [{ match: 'Braude', topicId: f.studies }]);
    assert.deepEqual(await Refiling.integration(google), { containers: 1, items: 1 });
    assert.equal(await topicOfContainer(f, braude), f.studies);
    assert.equal(await topicOfItem(item), f.studies);
    assert.equal(await topicOfContainer(f, plain), f.personal);

    await setRules(f, []);
    assert.deepEqual(await Refiling.integration(google), { containers: 1, items: 1 });
    assert.equal(await topicOfContainer(f, braude), f.personal);
    assert.equal(await topicOfItem(item), f.personal);
    assert.deepEqual(await Refiling.integration(google), { containers: 0, items: 0 });
  });

  it('re-files a GitHub board by its owner/projects key, not its title', async () => {
    const f = await fixture();
    const github = await connect(f, 'github', f.work);
    const board = await addContainer(f, github, 'Roadmap', f.work, 'shalev396/projects/3', 'b1');
    const lookalike = await addContainer(
      f,
      github,
      'shalev396/Roadmap',
      f.work,
      'other/projects/9',
      'b2',
    );
    const card = await addItem(f, github, board, 'card', f.work);
    await setRules(f, [{ match: 'shalev396/*', topicId: f.personal }]);

    await Refiling.integration(github);

    assert.equal(await topicOfContainer(f, board), f.personal);
    assert.equal(await topicOfItem(card), f.personal);
    assert.equal(await topicOfContainer(f, lookalike), f.work);
  });

  it('matches a name with regex characters only to itself', async () => {
    const f = await fixture();
    const google = await connect(f, 'google_calendar', f.personal);
    const exact = await addContainer(f, google, 'Calc. (I) [2026]', f.personal);
    const lookalike = await addContainer(f, google, 'Calc X (I) [2026]', f.personal);
    await setRules(f, [{ match: 'Calc. (I) [2026]', topicId: f.studies }]);

    await Refiling.integration(google);

    assert.equal(await topicOfContainer(f, exact), f.studies);
    assert.equal(await topicOfContainer(f, lookalike), f.personal);
  });

  it('a * in a name written into a rule stays a glob (F-A2)', async () => {
    const f = await fixture();
    const google = await connect(f, 'google_calendar', f.personal);
    const star = await addContainer(f, google, 'Q1 *', f.personal);
    const plan = await addContainer(f, google, 'Q1 plan', f.personal);
    await setRules(f, [{ match: 'Q1 *', topicId: f.studies }]);

    await Refiling.integration(google);

    assert.equal(await topicOfContainer(f, star), f.studies);
    assert.equal(await topicOfContainer(f, plan), f.studies);
  });

  it('never touches soft-deleted items, other integrations or local to-dos', async () => {
    const f = await fixture();
    const google = await connect(f, 'google_calendar', f.personal);
    const other = await connect(f, 'google_calendar', f.personal, 'acct-2');
    const cal = await addContainer(f, google, 'Cal', f.personal);
    const otherCal = await addContainer(f, other, 'Cal', f.personal);
    const live = await addItem(f, google, cal, 'live', f.personal);
    const gone = await addItem(f, google, cal, 'gone', f.personal);
    const foreign = await addItem(f, other, otherCal, 'foreign', f.personal);
    const items = await models.getItemRepository();
    await items.softDeleteBySource(
      f.wid,
      { provider: 'google_calendar', accountId: 'acct', integrationId: google.id },
      ['item-gone'],
    );
    const todo = await items.createLocal(f.wid, {
      ownerUserId: 'u-owner',
      title: 'todo',
      topicId: f.personal,
    });
    await setRules(f, [{ match: 'Cal', topicId: f.work }]);

    const counts = await Refiling.integration(google);

    assert.deepEqual(counts, { containers: 1, items: 1 });
    assert.equal(await topicOfItem(live), f.work);
    assert.equal(await topicOfItem(gone), f.personal);
    assert.equal(await topicOfItem(foreign), f.personal);
    assert.equal(await topicOfContainer(f, otherCal), f.personal);
    assert.equal(await topicOfItem(todo.id), f.personal);
  });
});

describe('Refiling.workspace', () => {
  it('re-files every live integration, and counts what changed', async () => {
    const f = await fixture();
    const one = await connect(f, 'google_calendar', f.personal);
    const two = await connect(f, 'google_calendar', f.personal, 'acct-2');
    const a = await addContainer(f, one, 'Braude', f.personal);
    const b = await addContainer(f, two, 'braude', f.personal);
    await addItem(f, one, a, 'x', f.personal);
    await addItem(f, two, b, 'y', f.personal);
    await setRules(f, [{ match: 'braude', topicId: f.studies }]);

    assert.deepEqual(await Refiling.workspace(f.wid), { containers: 2, items: 2 });
    assert.equal(await topicOfContainer(f, b), f.studies);
  });
});

describe('Container#matchKey', () => {
  it('is the GitHub key, else the name', async () => {
    const f = await fixture();
    const github = await connect(f, 'github', f.work);
    const google = await connect(f, 'google_calendar', f.personal);
    const board = await addContainer(f, github, 'Roadmap', f.work, 'shalev396/projects/3', 'b1');
    const cal = await addContainer(f, google, 'Braude', f.personal, 'ignored-key', 'c1');
    const all = await (await models.getContainerRepository()).list(f.wid, {});
    const byId = new Map(all.map((c) => [c.id, Container.from(c)]));
    assert.equal(byId.get(board)?.matchKey, 'shalev396/projects/3');
    assert.equal(byId.get(cal)?.matchKey, 'Braude');
    assert.equal(byId.get(board)?.toView().matchKey, 'shalev396/projects/3');
  });
});
