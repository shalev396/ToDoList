/**
 * The item rule lives twice in ItemPolicy: as the MongoDB filter every read starts from
 * (`filterFor`, `itemFilterUnabsorbed`) and as the in-memory decision on one item (`canRead`),
 * which item writes rely on after the filtered read. Over a matrix of items, callers, topic
 * narrowings and accesses, both must pick exactly the same items.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import { seedIntegration, shareIntegrations } from '../../testing/integrationFixtures.js';
import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { ItemKind, Provider, Role as RoleName } from '../../types/domain.js';
import type { Actor as ActorClass } from '../base/Actor.js';
import type { Caller as CallerClass } from '../base/Caller.js';
import type { ItemFacts, ItemPolicy as ItemPolicyClass } from './ItemPolicy.js';

const WS = 'w-agree';
const SETTINGS = { timezone: 'UTC', weekStart: 1 } as unknown as WorkspaceSettings;

type Doc = Record<string, unknown>;

/** Items covering every branch: own, shared and unshared integrations; private, shared and odd to-dos. */
const ITEMS: Doc[] = [
  {
    _id: 'todo-a-private',
    integrationId: null,
    ownerUserId: 'u-a',
    visibility: 'private',
    topicId: 't1',
  },
  {
    _id: 'todo-a-shared',
    integrationId: null,
    ownerUserId: 'u-a',
    visibility: 'workspace',
    topicId: 't2',
  },
  {
    _id: 'todo-b-private',
    integrationId: null,
    ownerUserId: 'u-b',
    visibility: 'private',
    topicId: 't1',
  },
  {
    _id: 'todo-b-shared',
    integrationId: null,
    ownerUserId: 'u-b',
    visibility: 'workspace',
    topicId: null,
  },
  { _id: 'todo-b-no-visibility', integrationId: null, ownerUserId: 'u-b', topicId: 't1' },
  {
    _id: 'todo-a-no-integration-field',
    ownerUserId: 'u-a',
    visibility: 'workspace',
    topicId: 't2',
  },
  {
    _id: 'todo-a-deleted',
    integrationId: null,
    ownerUserId: 'u-a',
    visibility: 'workspace',
    topicId: 't1',
    deletedAt: new Date(),
  },
  {
    _id: 'todo-b-elsewhere',
    workspaceId: 'w-other',
    integrationId: null,
    ownerUserId: 'u-b',
    visibility: 'workspace',
    topicId: 't1',
  },
  // Scheduled items: a block follows a to-do's visibility; a travel leg is its member's only,
  // even when it is stored workspace-visible (Ruling 8: belt and braces).
  {
    _id: 'block-b-shared',
    integrationId: null,
    ownerUserId: 'u-b',
    visibility: 'workspace',
    topicId: 't1',
    kind: 'block',
  },
  {
    _id: 'travel-a-shared',
    integrationId: null,
    ownerUserId: 'u-a',
    visibility: 'workspace',
    topicId: 't1',
    kind: 'travel',
  },
  {
    _id: 'travel-b-private',
    integrationId: null,
    ownerUserId: 'u-b',
    visibility: 'private',
    topicId: null,
    kind: 'travel',
  },
  { _id: 'jira-a', integrationId: 'i-a', provider: 'jira', topicId: 't1' },
  { _id: 'jira-a-no-topic', integrationId: 'i-a', provider: 'jira' },
  { _id: 'jira-b-shared', integrationId: 'i-b', provider: 'jira', topicId: 't2' },
  { _id: 'clickup-b-unshared', integrationId: 'i-c', provider: 'clickup', topicId: 't1' },
  { _id: 'gone-integration', integrationId: 'i-gone', provider: 'jira', topicId: 't1' },
];

function stored(item: Doc): Doc {
  const provider = typeof item['provider'] === 'string' ? item['provider'] : 'local';
  const rest = Object.fromEntries(Object.entries(item).filter(([key]) => key !== 'provider'));
  return {
    workspaceId: WS,
    deletedAt: null,
    source: {
      provider,
      url: provider === 'local' ? '' : `https://example.invalid/${String(item['_id'])}`,
    },
    ...rest,
  };
}

/** What ItemPolicy reads of a stored item, normalized as services/items.ts does. */
function factsOf(doc: Doc): ItemFacts {
  const text = (value: unknown): string | null => (typeof value === 'string' ? value : null);
  const source = doc['source'] as { provider: Provider; url: string };
  return {
    workspaceId: text(doc['workspaceId']) ?? '',
    integrationId: text(doc['integrationId']),
    ownerUserId: text(doc['ownerUserId']),
    visibility: doc['visibility'] === 'workspace' ? 'workspace' : 'private',
    topicId: text(doc['topicId']),
    deletedAt: doc['deletedAt'] instanceof Date ? doc['deletedAt'] : null,
    source,
    // A row without a kind reads as a to-do (itemRecord.ts).
    kind: (text(doc['kind']) ?? 'todo') as ItemKind,
  };
}

let db: TestDatabase;
let docs: Doc[] = [];
let ItemPolicy: typeof ItemPolicyClass;
let Caller: typeof CallerClass;
let Actor: typeof ActorClass;
let find: (filter: Doc) => Promise<string[]>;

before(async () => {
  db = await startTestDatabase('todolist_item_policy_agreement');
  ({ ItemPolicy } = await import('./ItemPolicy.js'));
  ({ Caller } = await import('../base/Caller.js'));
  ({ Actor } = await import('../base/Actor.js'));
  await seedIntegration(WS, {
    id: 'i-a',
    ownerUserId: 'u-a',
    provider: 'jira',
    accountId: 'acc-1',
  });
  await seedIntegration(WS, {
    id: 'i-b',
    ownerUserId: 'u-b',
    provider: 'jira',
    accountId: 'acc-1',
  });
  await seedIntegration(WS, { id: 'i-c', ownerUserId: 'u-b', provider: 'clickup' });
  await shareIntegrations(WS, 'u-b', ['i-b']);
  const mongoose = (await import('mongoose')).default;
  const items = mongoose.connection.collection('Items');
  docs = ITEMS.map(stored);
  await items.insertMany(docs.map((doc) => ({ ...doc })));
  find = async (filter: Doc): Promise<string[]> =>
    (await items.find(filter).toArray()).map((doc) => String(doc._id)).sort();
});

after(async () => {
  await db.stop();
});

const USERS = ['u-a', 'u-b', 'u-c'];
const ROLES: RoleName[] = ['viewer', 'editor', 'owner'];
const NARROWINGS: ((string | null)[] | undefined)[] = [undefined, ['t1'], [null], ['t2', null], []];

function callerOf(userId: string, role: RoleName, onlyTopics?: (string | null)[]): CallerClass {
  return Caller.fromContext(
    { id: WS, role, settings: SETTINGS, ...(onlyTopics === undefined ? {} : { onlyTopics }) },
    Actor.user(userId),
  );
}

function inMemory(policy: ItemPolicyClass, caller: CallerClass): string[] {
  return docs
    .filter((doc) => policy.canRead(caller, factsOf(doc)))
    .map((doc) => String(doc['_id']))
    .sort();
}

describe('ItemPolicy: the filter and canRead agree', () => {
  it('share-on-attach access (filterFor), every user, role and topic narrowing', async () => {
    let compared = 0;
    for (const userId of USERS) {
      for (const role of ROLES) {
        for (const onlyTopics of NARROWINGS) {
          const caller = callerOf(userId, role, onlyTopics);
          const policy = await ItemPolicy.for(caller);
          const label = `${userId}/${role}/${JSON.stringify(onlyTopics)}`;
          const expected = inMemory(policy, caller);
          assert.deepEqual(await find(await ItemPolicy.filterFor(caller)), expected, label);
          assert.deepEqual(
            await find(policy.itemFilterUnabsorbed(caller.context)),
            expected,
            label,
          );
          compared += 1;
        }
      }
    }
    assert.equal(compared, USERS.length * ROLES.length * NARROWINGS.length);
  });

  it('own-only access (a calendar push), every user and topic narrowing', async () => {
    for (const userId of USERS) {
      for (const onlyTopics of NARROWINGS) {
        const caller = callerOf(userId, 'owner', onlyTopics);
        const policy = await ItemPolicy.ownFor(caller);
        assert.deepEqual(
          await find(policy.itemFilterUnabsorbed(caller.context)),
          inMemory(policy, caller),
          `${userId}/${JSON.stringify(onlyTopics)}`,
        );
      }
    }
  });

  it('the effective projection never changes who sees what (overrides on every item)', async () => {
    const mongoose = (await import('mongoose')).default;
    const items = mongoose.connection.collection('Items');
    const { compileQuery } = await import('../../builder/compile.js');
    // Every item, private and unshared ones too, says it is done, due soon and retitled.
    await items.updateMany(
      {},
      {
        $set: {
          // What the provider says (stored): open, titled as it was.
          status: 'open',
          title: 'From the provider',
          'overlay.overrides': {
            title: 'Overridden',
            status: 'done',
            dueAt: new Date('2026-11-20T10:00:00Z'),
            allDay: true,
            startAt: null,
            priority: 4,
          },
        },
      },
    );
    try {
      for (const userId of USERS) {
        for (const role of ROLES) {
          for (const onlyTopics of NARROWINGS) {
            const caller = callerOf(userId, role, onlyTopics);
            const policy = await ItemPolicy.for(caller);
            const label = `${userId}/${role}/${JSON.stringify(onlyTopics)}`;
            const compiled = compileQuery(
              {
                source: 'items',
                where: {
                  combinator: 'and',
                  rules: [
                    { field: 'status', operator: '=', value: 'done' },
                    { field: 'title', operator: 'contains', value: 'Overridden' },
                  ],
                },
              },
              {
                ws: caller.context,
                userId,
                access: policy.access,
                vars: {},
                now: new Date('2026-11-15T00:00:00Z'),
                timeZone: 'UTC',
                weekStart: caller.settings.weekStart,
                preview: false,
                // Time-shaped, so it reads every kind the access lets through (blocks and legs too).
                blockType: 'calendar',
              },
            );
            // The pipeline up to its facet: the access filter, the prefilter, the projection, the filter.
            const stages = compiled.pipeline.slice(0, -1);
            const seen = (await items.aggregate([...stages, { $project: { _id: 1 } }]).toArray())
              .map((doc) => String(doc['_id']))
              .sort();
            assert.deepEqual(seen, inMemory(policy, caller), label);
          }
        }
      }
      // Not vacuous: the stored status (open, or none) no longer matches anyone's view.
      const a = callerOf('u-a', 'editor');
      const openOnes = compileQuery(
        {
          source: 'items',
          where: { combinator: 'and', rules: [{ field: 'status', operator: '=', value: 'open' }] },
        },
        {
          ws: a.context,
          userId: 'u-a',
          access: (await ItemPolicy.for(a)).access,
          vars: {},
          now: new Date('2026-11-15T00:00:00Z'),
          timeZone: 'UTC',
          weekStart: a.settings.weekStart,
          preview: false,
        },
      );
      const open = await items.aggregate(openOnes.pipeline.slice(0, -1)).toArray();
      assert.deepEqual(open, []);
    } finally {
      await items.updateMany({}, { $unset: { 'overlay.overrides': '', status: '', title: '' } });
    }
  });

  it('travel is readable by its owner only, even if stored workspace-visible', async () => {
    const [leg, theirLeg, block] = ['travel-a-shared', 'travel-b-private', 'block-b-shared'].map(
      (id) => {
        const doc = docs.find((candidate) => candidate['_id'] === id);
        assert.ok(doc, id);
        return doc;
      },
    );
    assert.ok(leg && theirLeg && block);
    for (const userId of USERS) {
      for (const role of ROLES) {
        const caller = callerOf(userId, role);
        const policy = await ItemPolicy.for(caller);
        const mine = userId === 'u-a';
        const label = `${userId}/${role}`;
        assert.equal(policy.canRead(caller, factsOf(leg)), mine, label);
        assert.equal(
          (await find(await ItemPolicy.filterFor(caller))).includes('travel-a-shared'),
          mine,
          label,
        );
        assert.equal(
          (await find(policy.itemFilterUnabsorbed(caller.context))).includes('travel-a-shared'),
          mine,
          label,
        );
        // Nor anyone else's private leg; a shared block is everyone's to see.
        assert.equal(policy.canRead(caller, factsOf(theirLeg)), userId === 'u-b', label);
        assert.equal(policy.canRead(caller, factsOf(block)), true, label);
      }
    }
  });

  it('the matrix is not vacuous: each rule picks something and leaves something out', async () => {
    const a = callerOf('u-a', 'editor');
    const seen = inMemory(await ItemPolicy.for(a), a);
    for (const id of [
      'todo-a-private',
      'todo-b-shared',
      'jira-a',
      'jira-b-shared',
      'todo-a-no-integration-field',
      'block-b-shared',
      'travel-a-shared',
    ]) {
      assert.ok(seen.includes(id), id);
    }
    for (const id of [
      'todo-b-private',
      'todo-b-no-visibility',
      'clickup-b-unshared',
      'todo-a-deleted',
      'todo-b-elsewhere',
      'gone-integration',
      'travel-b-private',
    ]) {
      assert.ok(!seen.includes(id), id);
    }
  });
});
