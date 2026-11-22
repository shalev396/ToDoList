/** SubjectMatches: live counts of what each subject would take, by the colours' own rule. */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startTestDatabase, type TestDatabase } from '../../testing/testDatabase.js';
import type { WorkspaceContext } from '../base/Caller.js';
import type * as Classes from '../workspace/index.js';
import type * as Items from '../../testing/itemCalls.js';
import type * as Models from '../../models/index.js';
import type * as Matches from './SubjectMatches.js';
import { callerOf } from '../../testing/workspaceFixtures.js';

let db: TestDatabase;
let Workspace: typeof Classes.Workspace;
let items: typeof Items;
let models: typeof Models;
let SubjectMatches: typeof Matches.SubjectMatches;

const ME = 'u-me';
let count = 0;

before(async () => {
  db = await startTestDatabase('todolist_subject_matches_test');
  ({ Workspace } = await import('../workspace/index.js'));
  ({ SubjectMatches } = await import('./SubjectMatches.js'));
  items = await import('../../testing/itemCalls.js');
  models = await import('../../models/index.js');
});

after(async () => {
  await db.stop();
});

async function workspace(): Promise<WorkspaceContext> {
  count += 1;
  const created = await (
    await models.getWorkspaceRepository()
  ).create({ name: 'Matches', slug: `matches-${String(count)}`, ownerId: 'u-owner' });
  const ws: WorkspaceContext = { id: created.id, role: 'editor', settings: created.settings };
  const caller = callerOf(ws, ME);
  await (
    await Workspace.load(caller)
  ).createAttribute(caller, {
    key: 'subject',
    name: 'Subject',
    type: 'select',
    options: ['Calculus', 'Algebra'],
  });
  const stored = await (await models.getWorkspaceRepository()).findById(ws.id);
  assert.ok(stored);
  return { ...ws, settings: stored.settings };
}

async function todo(
  ws: WorkspaceContext,
  title: string,
  subject?: string,
  user = ME,
): Promise<string> {
  const made = await items.createItem(ws, user, { title });
  if (subject !== undefined) {
    await items.updateOverlay(ws, user, made.item.id, { attrs: { subject } });
  }
  return made.item.id;
}

const calc = { name: 'Calculus', patterns: ['*חדו"א*'] };
const alg = { name: 'Algebra', patterns: ['*אלגברה*', '*חדו"א*'] };

describe('SubjectMatches.count', () => {
  it('counts a to-do copied to a provider once', async () => {
    const ws = await workspace();
    const todoId = await todo(ws, 'חדו"א copied');
    const { seedIntegration } = await import('../../testing/integrationFixtures.js');
    await seedIntegration(ws.id, {
      id: 'i-copy',
      ownerUserId: ME,
      provider: 'jira',
      accountId: 'a',
    });
    const repo = await models.getItemRepository();
    await repo.bulkUpsert(ws.id, [
      {
        integrationId: 'i-copy',
        kind: 'issue',
        topicId: null,
        title: 'חדו"א copied',
        status: 'open',
        source: {
          provider: 'jira',
          accountId: 'a',
          externalId: 'J-1',
          key: 'J-1',
          url: 'https://jira.example/J-1',
          updatedAtSource: null,
          etag: null,
          hash: null,
        },
      },
    ]);
    const [row] = await repo.aggregate(ws.id, [{ $match: { 'source.externalId': 'J-1' } }]);
    await repo.setOverlay(ws.id, String(row?.['_id']), {
      copyOf: todoId,
      copyOfOwner: ME,
      copyOfShared: true,
    });
    const { counts } = await SubjectMatches.count(callerOf(ws, ME), [calc]);
    assert.deepEqual(counts, [1]);
  });

  it('counts a copy whose to-do the pattern does not match (H5: only a to-do in the read hides it)', async () => {
    const ws = await workspace();
    const todoId = await todo(ws, 'Renamed since');
    const { seedIntegration } = await import('../../testing/integrationFixtures.js');
    await seedIntegration(ws.id, {
      id: 'i-copy-2',
      ownerUserId: ME,
      provider: 'jira',
      accountId: 'a',
    });
    const repo = await models.getItemRepository();
    await repo.bulkUpsert(ws.id, [
      {
        id: `${ws.id}-copy`,
        integrationId: 'i-copy-2',
        kind: 'issue',
        topicId: null,
        title: 'חדו"א at the source',
        status: 'open',
        source: {
          provider: 'jira',
          accountId: 'a',
          externalId: 'J-2',
          key: 'J-2',
          url: 'https://jira.example/J-2',
          updatedAtSource: null,
          etag: null,
          hash: null,
        },
      },
    ]);
    await repo.setOverlay(ws.id, `${ws.id}-copy`, {
      copyOf: todoId,
      copyOfOwner: ME,
      copyOfShared: true,
    });
    const { counts } = await SubjectMatches.count(callerOf(ws, ME), [calc]);
    assert.deepEqual(counts, [1]);
  });

  it('answers a read past its time limit with a 503', async (t) => {
    const ws = await workspace();
    const repo = await models.getItemRepository();
    const { default: mongoose } = await import('mongoose');
    t.mock.method(repo, 'aggregate', () =>
      Promise.reject(new mongoose.mongo.MongoServerError({ message: 'too slow', code: 50 })),
    );
    await assert.rejects(SubjectMatches.count(callerOf(ws, ME), [calc]), { statusCode: 503 });
  });

  it('counts a Hebrew title by its pattern, and one written with gershayim', async () => {
    const ws = await workspace();
    await todo(ws, 'חדו"א 1מ פרופ\' ילין מרק');
    await todo(ws, 'חדו״א 1מ');
    await todo(ws, 'אלגברה 1מח ד"ר שנבל אופיר');
    await todo(ws, 'Unrelated');
    const { counts, capped } = await SubjectMatches.count(callerOf(ws, ME), [calc, alg]);
    assert.deepEqual(counts, [2, 1]);
    assert.equal(capped, false);
  });

  it('an explicit value beats an earlier subject whose pattern matches', async () => {
    const ws = await workspace();
    await todo(ws, 'חדו"א 1מ', 'Algebra');
    const { counts } = await SubjectMatches.count(callerOf(ws, ME), [calc, alg]);
    assert.deepEqual(counts, [0, 1]);
  });

  it('a title matching two subjects counts to the first; reversing the request moves it', async () => {
    const ws = await workspace();
    await todo(ws, 'חדו"א 1מ');
    const caller = callerOf(ws, ME);
    assert.deepEqual((await SubjectMatches.count(caller, [calc, alg])).counts, [1, 0]);
    assert.deepEqual((await SubjectMatches.count(caller, [alg, calc])).counts, [1, 0]);
    const onlyAlg = { name: 'Algebra', patterns: ['*חדו"א*'] };
    const onlyCalc = { name: 'Calculus', patterns: ['*חדו"א*'] };
    assert.deepEqual((await SubjectMatches.count(caller, [onlyAlg, onlyCalc])).counts, [1, 0]);
    assert.deepEqual((await SubjectMatches.count(caller, [onlyCalc, onlyAlg])).counts, [1, 0]);
  });

  it('ignores case in Latin titles', async () => {
    const ws = await workspace();
    await todo(ws, 'Intro to CALCULUS');
    const { counts } = await SubjectMatches.count(callerOf(ws, ME), [
      { name: 'Calculus', patterns: ['*calc*'] },
    ]);
    assert.deepEqual(counts, [1]);
  });

  it("does not count another member's private to-do", async () => {
    const ws = await workspace();
    await (
      await models.getItemRepository()
    ).createLocal(ws.id, {
      ownerUserId: 'u-other',
      title: 'חדו"א private',
      topicId: null,
      visibility: 'private',
    });
    await todo(ws, 'חדו"א shared', undefined, 'u-other');
    const { counts } = await SubjectMatches.count(callerOf(ws, ME), [calc]);
    assert.deepEqual(counts, [1]);
  });

  it('stops at scanMax and says capped', async () => {
    const ws = await workspace();
    for (const n of ['a', 'b', 'c']) await todo(ws, `חדו"א ${n}`);
    const caller = callerOf(ws, ME);
    const capped = await SubjectMatches.count(caller, [calc], 2);
    assert.equal(capped.capped, true);
    assert.deepEqual(capped.counts, [2]);
    assert.equal((await SubjectMatches.count(caller, [calc], 3)).capped, false);
  });

  it('answers zeros for no subjects', async () => {
    const ws = await workspace();
    assert.deepEqual(await SubjectMatches.count(callerOf(ws, ME), []), {
      counts: [],
      capped: false,
    });
  });
});
