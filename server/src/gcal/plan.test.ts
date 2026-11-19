/**
 * The push plan reads the whole push set (fix round 1, I3): its rules are in the query (dated
 * within the window, not Google Calendar's own, not turned off), the live links' items are all
 * read, and the rest is paged, so with far more than 200 candidates a planned-only item is
 * created, a move still happens and a removed item's event is still deleted.
 */
import { after, before, describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { startGcalFixture, type GcalFixture } from '../testing/gcalFixture.js';
import type { IntegrationData } from '../models/index.js';
import type { loadPlan as LoadPlan } from '../testing/calendarCalls.js';
import { eventIdFor } from './diff.js';

let fx: GcalFixture;
let loadPlan: typeof LoadPlan;

const DAY = 86_400_000;
const NOW = new Date();

before(async () => {
  fx = await startGcalFixture('todolist_gcal_plan');
  ({ loadPlan } = await import('../testing/calendarCalls.js'));
});
after(async () => {
  await fx.stop();
});

async function integration(): Promise<IntegrationData> {
  const found = await (
    await fx.models.getIntegrationRepository()
  ).findById(fx.workspaceId, fx.integrationId);
  assert.ok(found);
  return found;
}

const dayIn = (days: number): string =>
  new Date(NOW.getTime() + days * DAY).toISOString().slice(0, 10);

describe('the push plan with more than 200 candidates', () => {
  const dated: string[] = [];
  const planned: string[] = [];

  it('creates every dated item, planned-only ones included; never what the rules leave out', async () => {
    const items = await fx.models.getItemRepository();
    for (let index = 0; index < 230; index += 1) {
      dated.push((await fx.item(`Dated ${String(index)}`, 1 + (index % 5))).id);
    }
    for (let index = 0; index < 3; index += 1) {
      const item = await fx.item(`Planned ${String(index)}`, 0, { dueAt: null });
      await items.setOverlay(fx.workspaceId, item.id, { plannedAt: dayIn(2 + index) });
      planned.push(item.id);
    }
    // Left out by the query: turned off, far outside the window, undated.
    const off = await fx.item('Turned off', 1);
    await items.setOverlay(fx.workspaceId, off.id, { calendarSync: false });
    await fx.item('Next year', 400);
    await fx.item('Undated', 0, { dueAt: null });

    const plan = await loadPlan(await integration(), NOW);
    assert.equal(plan.counts.create, 233);
    const created = new Set(plan.entries.filter((e) => e.type === 'create').map((e) => e.itemId));
    for (const id of planned) assert.ok(created.has(id), 'a planned-only item is created');
    assert.equal(created.has(off.id), false);
    assert.equal(plan.ops.length, 50, 'at most maxOpsPerRun are sent');
  });

  it('moves 210 linked events to the new primary calendar and deletes a removed item’s event', async () => {
    const links = await fx.models.getCalendarLinkRepository();
    for (const id of dated.slice(0, 210)) {
      await links.upsert(
        fx.workspaceId,
        fx.integrationId,
        { calendarId: 'old@example.test', googleEventId: eventIdFor(id) },
        { itemId: id, direction: 'to_google', pushedHash: 'x' },
      );
    }
    const removed = dated[229] ?? '';
    await links.upsert(
      fx.workspaceId,
      fx.integrationId,
      { calendarId: 'primary', googleEventId: eventIdFor(removed) },
      { itemId: removed, direction: 'to_google', pushedHash: 'x' },
    );
    await (await fx.models.getItemRepository()).softDelete(fx.workspaceId, removed);

    const plan = await loadPlan(await integration(), NOW);
    // 210 moves (delete there, create here) and the removed item's event.
    assert.equal(plan.counts.remove, 211);
    assert.equal(plan.counts.create, 232);
    assert.equal(
      plan.skipped.some((entry) => entry.reason === 'not_moved'),
      false,
    );
    assert.ok(plan.entries.some((entry) => entry.type === 'delete' && entry.itemId === removed));
    // A move's create goes right after its delete (moves first), so nothing is on neither
    // calendar for long.
    assert.deepEqual(
      plan.ops.slice(0, 4).map((op) => [op.type, op.calendarId]),
      [
        ['delete', 'old@example.test'],
        ['create', 'primary'],
        ['delete', 'old@example.test'],
        ['create', 'primary'],
      ],
    );
    assert.equal(plan.ops[0]?.eventId, plan.ops[1]?.eventId);
  });

  it('a narrowed dry run keeps a filter on a computed field (Importance), never the whole set', async () => {
    const none = await loadPlan(await integration(), NOW, {
      where: { combinator: 'and', rules: [{ field: 'importance', operator: '>', value: 1000 }] },
    });
    assert.equal(none.counts.create, 0);
    const all = await loadPlan(await integration(), NOW, {
      where: { combinator: 'and', rules: [{ field: 'importance', operator: '>=', value: 0 }] },
    });
    assert.ok(all.counts.create > 0);
  });

  it('a narrowed dry run reads its range by planned dates too, and deletes nothing', async () => {
    const day = dayIn(3);
    const plan = await loadPlan(await integration(), NOW, { range: { from: day, to: day } });
    const ids = new Set(plan.entries.map((entry) => entry.itemId));
    assert.ok(ids.has(planned[1] ?? ''), 'the item planned for that day');
    assert.equal(plan.counts.remove, 0);
  });
});

describe('the push plan reads the effective values (Phase 4a overrides)', () => {
  it('an undated mirrored item with a due-date override is pushed then, under its own title', async () => {
    const { seedIntegration } = await import('../testing/integrationFixtures.js');
    await seedIntegration(fx.workspaceId, {
      id: 'plan-github',
      ownerUserId: fx.userId,
      provider: 'github',
      accountId: 'plan-octo',
    });
    const items = await fx.models.getItemRepository();
    const account = { provider: 'github' as const, accountId: 'plan-octo' };
    await items.bulkUpsert(fx.workspaceId, [
      {
        integrationId: 'plan-github',
        kind: 'issue',
        topicId: null,
        title: 'Undated at GitHub',
        status: 'open',
        source: {
          ...account,
          externalId: 'plan-issue-1',
          key: null,
          url: 'https://github.com/octo/hello/issues/1',
          updatedAtSource: null,
          etag: null,
          hash: 'h',
        },
      },
    ]);
    const issue = await items.findBySource(
      fx.workspaceId,
      { ...account, integrationId: 'plan-github' },
      'plan-issue-1',
    );
    assert.ok(issue);
    const undated = await loadPlan(await integration(), NOW);
    assert.ok(!undated.entries.some((entry) => entry.itemId === issue.id), 'no date: not pushed');

    const due = new Date(NOW.getTime() + 4 * DAY);
    await items.setOverlay(fx.workspaceId, issue.id, {
      overrides: { dueAt: due, title: 'My name for it' },
    });
    const plan = await loadPlan(await integration(), NOW);
    const entry = plan.entries.find((candidate) => candidate.itemId === issue.id);
    assert.ok(entry, 'its override dates it');
    assert.deepEqual([entry.type, entry.title], ['create', 'My name for it']);
  });

  it('another member’s unshared item stays out, whatever its overrides date it', async () => {
    const { seedIntegration } = await import('../testing/integrationFixtures.js');
    await seedIntegration(fx.workspaceId, {
      id: 'plan-theirs',
      ownerUserId: 'u-another-member',
      provider: 'github',
      accountId: 'plan-theirs',
    });
    const items = await fx.models.getItemRepository();
    const account = { provider: 'github' as const, accountId: 'plan-theirs' };
    await items.bulkUpsert(fx.workspaceId, [
      {
        integrationId: 'plan-theirs',
        kind: 'issue',
        topicId: null,
        title: 'Theirs',
        status: 'open',
        source: {
          ...account,
          externalId: 'plan-theirs-1',
          key: null,
          url: 'https://github.com/them/x/issues/1',
          updatedAtSource: null,
          etag: null,
          hash: 'h',
        },
      },
    ]);
    const theirs = await items.findBySource(
      fx.workspaceId,
      { ...account, integrationId: 'plan-theirs' },
      'plan-theirs-1',
    );
    assert.ok(theirs);
    await items.setOverlay(fx.workspaceId, theirs.id, {
      overrides: { dueAt: new Date(NOW.getTime() + 2 * DAY) },
    });
    const plan = await loadPlan(await integration(), NOW);
    assert.ok(!plan.entries.some((entry) => entry.itemId === theirs.id));
  });
});

describe('the push set leaves out TodoList’s own reserved time (Ruling 26)', () => {
  it('blocks and travel are never in the workspace calendar push set', async () => {
    const start = new Date(NOW.getTime() + 2 * DAY);
    const end = new Date(start.getTime() + 60 * 60 * 1000);
    const timed = { dueAt: null, startAt: start, endAt: end };
    const block = await fx.item('Study: Math', 0, { ...timed, kind: 'block' });
    const area = await fx.item('Studying', 0, {
      ...timed,
      kind: 'block',
      props: { layer: 'area' },
    });
    const leg = await fx.item('Bus to Braude', 0, {
      ...timed,
      kind: 'travel',
      visibility: 'private',
    });
    // Asking for it on the item changes nothing (the item sheet's "send to the calendar").
    await (
      await fx.models.getItemRepository()
    ).setOverlay(fx.workspaceId, block.id, { calendarSync: true });
    // Not vacuous: a to-do at the same time is pushed.
    const todo = await fx.item('Hand in the essay', 0, timed);

    const plan = await loadPlan(await integration(), NOW);
    const planned = new Set(plan.entries.map((entry) => entry.itemId));
    assert.ok(planned.has(todo.id), 'a timed to-do is pushed');
    for (const item of [block, area, leg]) {
      assert.equal(planned.has(item.id), false, item.title);
    }
  });
});
