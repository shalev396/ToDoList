import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Layouts } from '@api-types/builder.ts';
import {
  changedItems,
  mergeMoved,
  mergePending,
  overlayLayout,
  placeBlocks,
  plainLayout,
  revertPending,
  scaleWidth,
  withPending,
} from './layouts.ts';

const base = [
  { i: 'a', x: 0, y: 0, w: 4, h: 2 },
  { i: 'b', x: 4, y: 0, w: 4, h: 2 },
];

describe('changedItems', () => {
  it('lists the items whose position or size differ, or that are new', () => {
    const next = [
      { i: 'a', x: 0, y: 0, w: 4, h: 2 },
      { i: 'b', x: 4, y: 2, w: 4, h: 2 },
      { i: 'c', x: 0, y: 4, w: 2, h: 2 },
    ];
    assert.deepEqual(changedItems(next, base), [next[1], next[2]]);
    assert.deepEqual(changedItems(base, base), []);
  });
});

describe('overlayLayout', () => {
  it('puts the overlay’s positions on the base, keeping its order and appending the rest', () => {
    assert.deepEqual(
      overlayLayout(base, [
        { i: 'b', x: 8, y: 0, w: 4, h: 2 },
        { i: 'c', x: 0, y: 2, w: 2, h: 2 },
      ]),
      [
        { i: 'a', x: 0, y: 0, w: 4, h: 2 },
        { i: 'b', x: 8, y: 0, w: 4, h: 2 },
        { i: 'c', x: 0, y: 2, w: 2, h: 2 },
      ],
    );
  });
});

describe('withPending', () => {
  const layouts: Layouts = { lg: base, md: [], sm: [] };

  it('shows pending positions on top of the stored ones, per breakpoint', () => {
    const shown = withPending(layouts, { lg: [{ i: 'a', x: 8, y: 0, w: 4, h: 2 }] });
    assert.deepEqual(shown.lg[0], { i: 'a', x: 8, y: 0, w: 4, h: 2 });
    assert.equal(shown.md, layouts.md);
  });

  it('is the stored layouts when nothing is pending', () => {
    assert.equal(withPending(layouts, null), layouts);
  });
});

describe('placeBlocks', () => {
  const blocks = [
    { id: 'a', type: 'clock' },
    { id: 'b', type: 'chart' },
    { id: 'n', type: 'table' },
  ] as const;
  const size = (type: string) => (type === 'table' ? { w: 12, h: 8 } : { w: 4, h: 8 });

  it('keeps stored positions, drops unknown ids and stacks unplaced blocks below', () => {
    const stored = [...base, { i: 'gone', x: 0, y: 9, w: 2, h: 2 }];
    assert.deepEqual(placeBlocks(stored, blocks, 12, size), [
      { i: 'a', x: 0, y: 0, w: 4, h: 2 },
      { i: 'b', x: 4, y: 0, w: 4, h: 2 },
      { i: 'n', x: 0, y: 2, w: 12, h: 8 },
    ]);
  });

  it('scales a new block’s width to the grid and clamps stored ones into it', () => {
    assert.deepEqual(placeBlocks([], [{ id: 'n', type: 'table' }], 8, size), [
      { i: 'n', x: 0, y: 0, w: 8, h: 8 },
    ]);
    assert.deepEqual(
      placeBlocks([{ i: 'a', x: 6, y: 0, w: 4, h: 2 }], [{ id: 'a', type: 'clock' }], 8, size),
      [{ i: 'a', x: 4, y: 0, w: 4, h: 2 }],
    );
    assert.deepEqual(
      placeBlocks([{ i: 'a', x: 0, y: 3, w: 4, h: 2 }], [{ id: 'a', type: 'clock' }], 1, size),
      [{ i: 'a', x: 0, y: 3, w: 1, h: 2 }],
    );
  });
});

describe('scaleWidth', () => {
  it('scales a 12-column width, at least one column', () => {
    assert.equal(scaleWidth(12, 8), 8);
    assert.equal(scaleWidth(4, 8), 3);
    assert.equal(scaleWidth(3, 1), 1);
    assert.equal(scaleWidth(1, 8), 1);
  });
});

describe('plainLayout', () => {
  it('keeps only i, x, y, w and h (what the API stores)', () => {
    const rich = [{ i: 'a', x: 0, y: 0, w: 4, h: 2, moved: false, static: false, minW: 2 }];
    assert.deepEqual(plainLayout(rich), [{ i: 'a', x: 0, y: 0, w: 4, h: 2 }]);
  });
});

describe('revertPending', () => {
  const before: Layouts = { lg: base, md: [{ i: 'a', x: 0, y: 0, w: 8, h: 2 }], sm: [] };
  const applied = {
    lg: [{ i: 'a', x: 8, y: 0, w: 4, h: 2 }],
    sm: [{ i: 'a', x: 0, y: 0, w: 1, h: 2 }],
  };

  it('puts each applied block back where it was, and drops one that had no position', () => {
    const shown = withPending(before, applied);
    assert.deepEqual(revertPending(shown, applied, before), before);
  });

  it('leaves a block that changed again since (a reload, someone else’s position)', () => {
    const reloaded: Layouts = {
      ...withPending(before, applied),
      lg: [
        { i: 'a', x: 4, y: 4, w: 4, h: 2 },
        { i: 'b', x: 4, y: 0, w: 4, h: 2 },
      ],
    };
    const reverted = revertPending(reloaded, applied, before);
    assert.deepEqual(reverted.lg, reloaded.lg);
    assert.deepEqual(reverted.sm, [], 'the rest still goes back');
    assert.equal(reverted.md, reloaded.md, 'untouched breakpoints stay the same arrays');
  });
});

describe('mergePending', () => {
  it('keeps the older positions and puts the newer ones on top, per breakpoint', () => {
    const older = {
      lg: [
        { i: 'a', x: 8, y: 0, w: 4, h: 2 },
        { i: 'b', x: 0, y: 0, w: 4, h: 2 },
      ],
    };
    const newer = {
      lg: [{ i: 'a', x: 0, y: 2, w: 4, h: 2 }],
      md: [{ i: 'c', x: 0, y: 0, w: 8, h: 2 }],
    };
    assert.deepEqual(mergePending(older, newer), {
      lg: [
        { i: 'a', x: 0, y: 2, w: 4, h: 2 },
        { i: 'b', x: 0, y: 0, w: 4, h: 2 },
      ],
      md: [{ i: 'c', x: 0, y: 0, w: 8, h: 2 }],
    });
    assert.deepEqual(mergePending(older, null), older);
  });
});

describe('mergeMoved', () => {
  it('joins the moved blocks per breakpoint, once each', () => {
    assert.deepEqual(mergeMoved({ lg: ['a', 'b'] }, { lg: ['b', 'c'], sm: ['a'] }), {
      lg: ['a', 'b', 'c'],
      sm: ['a'],
    });
    assert.deepEqual(mergeMoved({ md: ['a'] }, null), { md: ['a'] });
  });
});
