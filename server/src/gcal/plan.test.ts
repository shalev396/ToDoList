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
import type { loadPlan as LoadPlan } from './plan.js';
import { eventIdFor } from './diff.js';

let fx: GcalFixture;
let loadPlan: typeof LoadPlan;

const DAY = 86_400_000;
const NOW = new Date();

before(async () => {
  fx = await startGcalFixture('todolist_gcal_plan');
  ({ loadPlan } = await import('./plan.js'));
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
