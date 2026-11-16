import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Block, LayoutItem, Layouts } from '@api-types/builder.ts';
import { overlayLayout } from '../grid/layouts.ts';
import { planConflictRecovery } from './conflict.ts';

function block(id: string): Block {
  return { id, type: 'list', title: id, viz: { kind: 'list' }, query: { source: 'items' } };
}

function fresh(ids: string[], layouts: Partial<Layouts>, version = 7) {
  return {
    version,
    blocks: ids.map(block),
    layouts: { lg: [], md: [], sm: [], ...layouts },
  };
}

function overlaps(a: LayoutItem, b: LayoutItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function assertNoOverlap(layout: readonly LayoutItem[]): void {
  layout.forEach((a, index) => {
    for (const b of layout.slice(index + 1)) {
      assert.equal(overlaps(a, b), false, `${a.i} and ${b.i} overlap`);
    }
  });
}

/** Every order of `items`. */
function orders<T>(items: readonly T[]): T[][] {
  if (items.length <= 1) {
    return [[...items]];
  }
  return items.flatMap((item, index) =>
    orders([...items.slice(0, index), ...items.slice(index + 1)]).map((rest) => [item, ...rest]),
  );
}

describe('planConflictRecovery', () => {
  it('every pending block still exists: re-apply the positions on the fresh version', () => {
    // Someone else moved b and added n meanwhile; my change moved a to the end of the row.
    const current = fresh(['blk_a', 'blk_b', 'blk_n'], {
      lg: [
        { i: 'blk_a', x: 0, y: 0, w: 4, h: 2 },
        { i: 'blk_b', x: 0, y: 2, w: 4, h: 2 },
        { i: 'blk_n', x: 8, y: 0, w: 4, h: 2 },
      ],
    });
    const plan = planConflictRecovery(
      { layouts: { lg: [{ i: 'blk_a', x: 8, y: 0, w: 4, h: 2 }] }, moved: { lg: ['blk_a'] } },
      current,
    );
    assert.equal(plan.kind, 'reapply');
    assert.equal(plan.expectedVersion, 7);
    const saved = plan.layouts.lg ?? [];
    assert.deepEqual(
      saved.find((item) => item.i === 'blk_a'),
      { i: 'blk_a', x: 8, y: 0, w: 4, h: 2 },
      'my position wins',
    );
    // What gets saved, on top of the fresh layout, is a whole valid layout.
    assertNoOverlap(overlayLayout(current.layouts.lg, saved));
    assert.equal(Object.keys(plan.layouts).join(), 'lg', 'only the breakpoints I changed');
  });

  it('a pending block is gone: drop the local change (never half-apply it)', () => {
    const current = fresh(['blk_a'], {
      lg: [{ i: 'blk_a', x: 0, y: 0, w: 4, h: 2 }],
      md: [{ i: 'blk_a', x: 0, y: 0, w: 4, h: 2 }],
    });
    const plan = planConflictRecovery(
      {
        layouts: {
          lg: [{ i: 'blk_a', x: 4, y: 0, w: 4, h: 2 }],
          md: [{ i: 'blk_b', x: 4, y: 0, w: 4, h: 2 }],
        },
        moved: { lg: ['blk_a'], md: ['blk_b'] },
      },
      current,
    );
    assert.deepEqual(plan, { kind: 'drop', missing: ['blk_b'] });
  });

  it('the fresh version already holds my positions: nothing left to save', () => {
    const current = fresh(['blk_a'], { lg: [{ i: 'blk_a', x: 4, y: 0, w: 4, h: 2 }] });
    const plan = planConflictRecovery(
      { layouts: { lg: [{ i: 'blk_a', x: 4, y: 0, w: 4, h: 2 }] }, moved: { lg: ['blk_a'] } },
      current,
    );
    assert.deepEqual(plan, { kind: 'resolved' });
  });

  it('nothing pending is nothing to save', () => {
    assert.deepEqual(planConflictRecovery({ layouts: {}, moved: {} }, fresh(['blk_a'], {})), {
      kind: 'resolved',
    });
  });

  it('packs the fresh layout around my positions, on each breakpoint’s own grid', () => {
    const current = fresh(['blk_a', 'blk_b'], {
      md: [
        { i: 'blk_a', x: 0, y: 0, w: 4, h: 2 },
        { i: 'blk_b', x: 4, y: 0, w: 4, h: 2 },
      ],
    });
    // a widened to the whole md row (8 columns) runs into b, which must move down.
    const plan = planConflictRecovery(
      { layouts: { md: [{ i: 'blk_a', x: 0, y: 0, w: 8, h: 2 }] }, moved: { md: ['blk_a'] } },
      current,
    );
    assert.equal(plan.kind, 'reapply');
    const saved = overlayLayout(current.layouts.md, plan.layouts.md ?? []);
    assertNoOverlap(saved);
    assert.deepEqual(
      saved.find((item) => item.i === 'blk_b'),
      { i: 'blk_b', x: 4, y: 2, w: 4, h: 2 },
    );
  });
  it('my moved block wins its place, in whatever order the fresh layout lists the blocks', () => {
    const lg: LayoutItem[] = [
      { i: 'blk_a', x: 0, y: 0, w: 4, h: 2 },
      { i: 'blk_b', x: 0, y: 2, w: 4, h: 2 },
      { i: 'blk_n', x: 8, y: 0, w: 4, h: 2 },
    ];
    const mine = { i: 'blk_a', x: 8, y: 0, w: 4, h: 2 };
    for (const order of orders(lg)) {
      const current = fresh(['blk_a', 'blk_b', 'blk_n'], { lg: order });
      const plan = planConflictRecovery(
        { layouts: { lg: [mine] }, moved: { lg: ['blk_a'] } },
        current,
      );
      const listed = order.map((item) => item.i).join();
      assert.equal(plan.kind, 'reapply', listed);
      const saved = overlayLayout(current.layouts.lg, plan.layouts.lg ?? []);
      assert.deepEqual(
        saved.find((item) => item.i === 'blk_a'),
        mine,
        `my position wins (${listed})`,
      );
      assert.deepEqual(
        saved.find((item) => item.i === 'blk_n'),
        { i: 'blk_n', x: 8, y: 2, w: 4, h: 2 },
        `theirs moves under it (${listed})`,
      );
      assertNoOverlap(saved);
    }
  });

  it('re-applies only the blocks I moved; the ones they pushed follow the fresh layout', () => {
    // I made a taller, which pushed b down; meanwhile someone moved b to the end of the row.
    const current = fresh(['blk_a', 'blk_b'], {
      lg: [
        { i: 'blk_a', x: 0, y: 0, w: 4, h: 2 },
        { i: 'blk_b', x: 8, y: 0, w: 4, h: 2 },
      ],
    });
    const plan = planConflictRecovery(
      {
        layouts: {
          lg: [
            { i: 'blk_a', x: 0, y: 0, w: 4, h: 4 },
            { i: 'blk_b', x: 0, y: 4, w: 4, h: 2 },
          ],
        },
        moved: { lg: ['blk_a'] },
      },
      current,
    );
    assert.deepEqual(plan, {
      kind: 'reapply',
      expectedVersion: 7,
      layouts: { lg: [{ i: 'blk_a', x: 0, y: 0, w: 4, h: 4 }] },
    });
  });

  it('a block I only pushed being gone does not drop my change', () => {
    const current = fresh(['blk_a'], { lg: [{ i: 'blk_a', x: 0, y: 0, w: 4, h: 2 }] });
    const plan = planConflictRecovery(
      {
        layouts: {
          lg: [
            { i: 'blk_a', x: 4, y: 0, w: 4, h: 2 },
            { i: 'blk_gone', x: 0, y: 2, w: 4, h: 2 },
          ],
        },
        moved: { lg: ['blk_a'] },
      },
      current,
    );
    assert.deepEqual(plan, {
      kind: 'reapply',
      expectedVersion: 7,
      layouts: { lg: [{ i: 'blk_a', x: 4, y: 0, w: 4, h: 2 }] },
    });
  });
});
