/**
 * The topics service (H2, dynamic topics): default topics with stable ids, CRUD for editors and
 * up, slug rules, and a delete that removes only the topic's pages while its items stay, Unsorted.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { SourceRef } from '../../models/definitions/common.js';
import type { WorkspaceContext } from '../base/Caller.js';
import type * as Classes from './index.js';
import { callerOf } from '../../testing/workspaceFixtures.js';
import type * as Models from '../../models/index.js';

let db: TestDatabase;
let Topic: typeof Classes.Topic;
let models: typeof Models;

const EDITOR = 'u-editor';
let workspaces = 0;

before(async () => {
  db = await startTestDatabase('todolist_topics_service_test');
  ({ Topic } = await import('./index.js'));
  models = await import('../../models/index.js');
  const { TopicMongoModel } = await import('../../models/mongoose/Topic.js');
  await TopicMongoModel.syncIndexes();
});

after(async () => {
  await db.stop();
});

async function workspace(role: WorkspaceContext['role'] = 'editor'): Promise<WorkspaceContext> {
  workspaces += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Topics', slug: `topics-${String(workspaces)}`, ownerId: 'u-owner' });
  return { id: created.id, role, settings: created.settings };
}

function source(externalId: string): SourceRef {
  return {
    provider: 'github' as const,
    accountId: 'acct',
    externalId,
    key: null,
    url: `https://github.example/${externalId}`,
    updatedAtSource: null,
    etag: null,
    hash: null,
  };
}

describe('defaultTopicId', () => {
  it('is stable, UUID-shaped, and differs by workspace and slug', () => {
    const work = Topic.defaultId('w-1', 'work');
    assert.equal(Topic.defaultId('w-1', 'work'), work);
    assert.match(work, /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    assert.notEqual(Topic.defaultId('w-2', 'work'), work);
    assert.notEqual(Topic.defaultId('w-1', 'college'), work);
  });
});

describe('ensureDefaultTopics', () => {
  it('creates the missing defaults with their stable ids, in the language asked, once', async () => {
    const ws = await workspace();
    await Topic.ensureDefaults(ws.id, ['personal'], 'he');
    const all = await Topic.ensureDefaults(ws.id, ['work', 'college', 'personal'], 'en');
    assert.deepEqual(
      all.map((topic) => [topic.slug, topic.name, topic.id, topic.icon]),
      [
        ['personal', 'אישי', Topic.defaultId(ws.id, 'personal'), 'leaf'],
        ['work', 'Work', Topic.defaultId(ws.id, 'work'), 'briefcase'],
        ['college', 'College', Topic.defaultId(ws.id, 'college'), 'graduation-cap'],
      ],
    );
    const again = await Topic.ensureDefaults(ws.id, ['work', 'college', 'personal'], 'en');
    assert.equal(again.length, 3);
  });

  it('a default a concurrent run made first never stops the ones after it', async () => {
    const ws = await workspace();
    const repository = await models.getTopicRepository();
    // The concurrent run's `work` lands after this run read the list.
    await repository.create(ws.id, {
      id: Topic.defaultId(ws.id, 'work'),
      name: 'Work',
      slug: 'work',
      order: 0,
    });
    const original = Object.getOwnPropertyDescriptor(repository, 'list');
    assert.ok(original);
    const list = repository.list.bind(repository);
    let reads = 0;
    Object.assign(repository, {
      list: async (workspaceId: string) => {
        reads += 1;
        return reads === 1 ? [] : list(workspaceId);
      },
    });
    try {
      const all = await Topic.ensureDefaults(ws.id, ['work', 'college', 'personal'], 'en');
      assert.deepEqual(all.map((topic) => topic.slug).sort(), ['college', 'personal', 'work']);
    } finally {
      Object.defineProperty(repository, 'list', original);
    }
    assert.deepEqual((await Topic.list(ws.id)).map((topic) => topic.slug).sort(), [
      'college',
      'personal',
      'work',
    ]);
  });
});

describe('createTopic', () => {
  it('standardizes the slug, keeps it unique and appends the topic at the end', async () => {
    const ws = await workspace();
    await Topic.ensureDefaults(ws.id, ['work'], 'en');
    const acme = await Topic.create(callerOf(ws, EDITOR), { name: '  Acme   Corp ' });
    assert.deepEqual(
      [acme.name, acme.slug, acme.createdBy],
      ['Acme   Corp', 'acme-corp', 'u-editor'],
    );
    const work2 = await Topic.create(callerOf(ws, EDITOR), { name: 'WORK!', colour: 'teal' });
    assert.deepEqual([work2.slug, work2.colour], ['work-2', 'teal']);
    const hebrew = await Topic.create(callerOf(ws, EDITOR), { name: 'עבודה בלילה', icon: 'star' });
    assert.equal(hebrew.slug, 'עבודה-בלילה');
    const listed = await Topic.list(ws.id);
    assert.deepEqual(
      listed.map((topic) => topic.slug),
      ['work', 'acme-corp', 'work-2', 'עבודה-בלילה'],
    );
    const audit = await (await models.getAuditLogRepository()).list(ws.id, {}, 10);
    assert.ok(audit.some((entry) => entry.action === 'topic.create' && entry.targetId === acme.id));
  });

  it('refuses viewers, empty or long names, and more topics than the cap', async () => {
    const ws = await workspace();
    await assert.rejects(Topic.create(callerOf({ ...ws, role: 'viewer' }, EDITOR), { name: 'X' }), {
      statusCode: 403,
    });
    await assert.rejects(Topic.create(callerOf(ws, EDITOR), { name: '   ' }), { statusCode: 400 });
    await assert.rejects(Topic.create(callerOf(ws, EDITOR), { name: 'x'.repeat(61) }), {
      statusCode: 400,
    });
    const repository = await models.getTopicRepository();
    for (let index = 0; index < 50; index += 1) {
      await repository.create(ws.id, {
        name: `T${String(index)}`,
        slug: `t${String(index)}`,
        order: index,
      });
    }
    await assert.rejects(Topic.create(callerOf(ws, EDITOR), { name: 'One more' }), {
      statusCode: 409,
    });
  });

  it('starts the page from a topic template, bound to the new topic', async () => {
    const ws = await workspace();
    const { topic, dashboardId } = await Topic.createPage(callerOf(ws, EDITOR), {
      name: 'Night job',
      templateKey: 'work@1',
      language: 'en',
    });
    const dashboard = await (await models.getDashboardRepository()).findById(ws.id, dashboardId);
    assert.ok(dashboard);
    assert.equal(dashboard.scope.topicId, topic.id);
    assert.equal(dashboard.scope.page, 'topic');
    assert.equal(dashboard.title, 'Night job');
    assert.equal(dashboard.vars['topic'], topic.id);
    assert.ok(dashboard.blocks.length > 0);
  });

  it('starts an empty page without a template, and refuses a group template', async () => {
    const ws = await workspace();
    const { topic, dashboardId } = await Topic.createPage(callerOf(ws, EDITOR), {
      name: 'Garden',
      language: 'en',
    });
    const dashboard = await (await models.getDashboardRepository()).findById(ws.id, dashboardId);
    assert.deepEqual([dashboard?.scope.topicId, dashboard?.blocks.length], [topic.id, 0]);
    await assert.rejects(
      Topic.createPage(callerOf(ws, EDITOR), {
        name: 'Courses',
        templateKey: 'college-course@1',
        language: 'en',
      }),
      { statusCode: 400 },
    );
    // A refused template leaves no topic behind.
    assert.equal(
      (await Topic.list(ws.id)).some((entry) => entry.name === 'Courses'),
      false,
    );
  });
});

describe('updateTopic', () => {
  it('renames, recolours and moves a topic, and keeps its slug', async () => {
    const ws = await workspace();
    const created = await Topic.create(callerOf(ws, EDITOR), { name: 'Side gig' });
    const renamed = await Topic.update(callerOf(ws, EDITOR), created.id, {
      name: 'Freelance',
      colour: 'violet',
      icon: 'code',
      order: 7,
    });
    assert.deepEqual(
      [renamed.name, renamed.slug, renamed.colour, renamed.icon, renamed.order],
      ['Freelance', 'side-gig', 'violet', 'code', 7],
    );
    await assert.rejects(Topic.update(callerOf(ws, EDITOR), created.id, { name: '' }), {
      statusCode: 400,
    });
    await assert.rejects(
      Topic.update(callerOf({ ...ws, role: 'viewer' }, EDITOR), created.id, { name: 'No' }),
      { statusCode: 403 },
    );
    await assert.rejects(Topic.update(callerOf(ws, EDITOR), 'missing', { name: 'No' }), {
      statusCode: 404,
    });
  });
});

describe('deleteTopic', () => {
  it('removes only its pages; its items, local to-dos included, stay as Unsorted', async () => {
    const ws = await workspace();
    const [work, personal] = await Topic.ensureDefaults(ws.id, ['work', 'personal'], 'en');
    assert.ok(work && personal);
    const dashboards = await models.getDashboardRepository();
    const workPage = await dashboards.create(ws.id, {
      ownerUserId: 'u-owner',
      title: 'Work',
      scope: { topicId: work.id, page: 'topic' },
    });
    const workGroup = await dashboards.create(ws.id, {
      ownerUserId: 'u-owner',
      title: 'Project',
      scope: { topicId: work.id, page: 'group', groupVar: 'project' },
    });
    const personalPage = await dashboards.create(ws.id, {
      ownerUserId: 'u-owner',
      title: 'Personal',
      scope: { topicId: personal.id, page: 'topic' },
    });
    const main = await dashboards.create(ws.id, { ownerUserId: 'u-owner', title: 'Main' });

    const items = await models.getItemRepository();
    const todo = await items.createLocal(ws.id, {
      ownerUserId: 'u-owner',
      title: 'Local to-do',
      topicId: work.id,
    });
    const keep = await items.createLocal(ws.id, {
      ownerUserId: 'u-owner',
      title: 'Personal to-do',
      topicId: personal.id,
    });
    await items.setOverlay(ws.id, keep.id, { topicOverride: work.id });
    const integration = await (
      await models.getIntegrationRepository()
    ).create(ws.id, {
      connectedBy: 'u-owner',
      provider: 'github',
      accountId: 'acct',
      label: 'GitHub',
      authMethod: 'classic_pat',
      topicId: work.id,
    });
    await (
      await models.getContainerRepository()
    ).bulkUpsert(ws.id, [
      {
        integrationId: integration.id,
        topicId: work.id,
        type: 'repo',
        name: 'acme/api',
        source: source('repo-1'),
      },
    ]);
    await (
      await models.getWorkspaceRepository()
    ).update(ws.id, {
      settings: {
        topicRules: [
          { match: 'acme/*', topicId: work.id },
          { match: 'me/*', topicId: personal.id },
        ],
      },
    });

    const result = await Topic.delete(callerOf(ws, EDITOR), work.id);
    assert.deepEqual(result, { dashboards: 2, items: 1, containers: 1, integrations: 1, rules: 1 });

    assert.equal(await dashboards.findById(ws.id, workPage.id), null);
    assert.equal(await dashboards.findById(ws.id, workGroup.id), null);
    assert.notEqual(await dashboards.findById(ws.id, personalPage.id), null);
    assert.notEqual(await dashboards.findById(ws.id, main.id), null);

    const kept = await items.findById(ws.id, todo.id);
    assert.deepEqual([kept?.title, kept?.topicId, kept?.deletedAt], ['Local to-do', null, null]);
    const other = await items.findById(ws.id, keep.id);
    assert.deepEqual([other?.topicId, other?.overlay.topicOverride], [personal.id, null]);
    const [container] = await (await models.getContainerRepository()).list(ws.id, {});
    assert.equal(container?.topicId, null);
    const connected = await (
      await models.getIntegrationRepository()
    ).findById(ws.id, integration.id);
    assert.equal(connected?.topicId, null);
    const settings = (await (await models.getWorkspaceRepository()).findById(ws.id))?.settings;
    assert.deepEqual(settings?.topicRules, [{ match: 'me/*', topicId: personal.id }]);
    assert.deepEqual(
      (await Topic.list(ws.id)).map((topic) => topic.slug),
      ['personal'],
    );
  });

  it('refuses viewers and unknown topics', async () => {
    const ws = await workspace();
    const [personal] = await Topic.ensureDefaults(ws.id, ['personal'], 'en');
    assert.ok(personal);
    await assert.rejects(Topic.delete(callerOf({ ...ws, role: 'viewer' }, EDITOR), personal.id), {
      statusCode: 403,
    });
    await assert.rejects(Topic.delete(callerOf(ws, EDITOR), 'missing'), { statusCode: 404 });
  });
});

describe('removeAllIn', () => {
  it('refuses a live workspace, and removes the topics of a deleted one', async () => {
    const ws = await workspace();
    await Topic.ensureDefaults(ws.id, ['work', 'personal'], 'en');
    await assert.rejects(
      Topic.removeAllIn(ws.id),
      (error: unknown) => (error as { statusCode?: number }).statusCode === 500,
    );
    assert.equal((await Topic.idsIn(ws.id)).size, 2, 'the live workspace keeps its topics');
    await (await models.getWorkspaceRepository()).softDelete(ws.id);
    assert.equal(await Topic.removeAllIn(ws.id), 2);
    assert.equal((await Topic.idsIn(ws.id)).size, 0);
  });
});

describe('topic lookups', () => {
  it('finds a topic id by slug and checks a topic id belongs to the workspace', async () => {
    const ws = await workspace();
    const other = await workspace();
    const [personal] = await Topic.ensureDefaults(ws.id, ['personal'], 'en');
    assert.ok(personal);
    assert.equal((await Topic.bySlug(ws.id, 'personal'))?.id ?? null, personal.id);
    assert.equal((await Topic.bySlug(ws.id, 'work'))?.id ?? null, null);
    await Topic.assertOf(ws.id, personal.id);
    await assert.rejects(Topic.assertOf(other.id, personal.id), { statusCode: 400 });
  });
});

describe('topic families', () => {
  it('gives new topics the next unused family in sidebar order', async () => {
    const ws = await workspace();
    const defaults = await Topic.ensureDefaults(ws.id, ['work', 'college', 'personal'], 'en');
    assert.deepEqual(
      defaults.map((topic) => topic.colour),
      ['blue', 'orange', 'teal'],
    );
    const fourth = await Topic.create(callerOf(ws, EDITOR), { name: 'Fourth' });
    assert.equal(fourth.colour, 'amber');
  });

  it('keeps a family chosen by hand and re-assigns on null', async () => {
    const ws = await workspace();
    await Topic.ensureDefaults(ws.id, ['work'], 'en');
    const chosen = await Topic.create(callerOf(ws, EDITOR), { name: 'Chosen', colour: 'gray' });
    assert.equal(chosen.colour, 'gray');
    const other = await Topic.create(callerOf(ws, EDITOR), { name: 'Other' });
    assert.equal(other.colour, 'orange');
    const again = await Topic.update(callerOf(ws, EDITOR), chosen.id, { colour: null });
    // blue and orange are taken by the others; gray does not count.
    assert.equal(again.colour, 'teal');
  });

  it('reuses blue for the ninth topic and never picks gray', async () => {
    const ws = await workspace();
    const colours: (string | null)[] = [];
    for (let index = 1; index <= 9; index += 1) {
      const topic = await Topic.create(callerOf(ws, EDITOR), { name: `Topic ${String(index)}` });
      colours.push(topic.colour);
    }
    assert.equal(colours[8], 'blue');
    assert.ok(colours.every((colour) => colour !== 'gray'));
  });
});
