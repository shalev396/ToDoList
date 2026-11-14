import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { GRID_COLS } from './constants.ts';
import { mirrorLayout, mirrorX } from './rtl.ts';

const lg = [
  { i: 'blk_area', x: 0, y: 0, w: 12, h: 2 },
  { i: 'blk_clock', x: 0, y: 2, w: 4, h: 8 },
  { i: 'blk_donut', x: 4, y: 2, w: 4, h: 8 },
  { i: 'blk_deadlines', x: 8, y: 2, w: 4, h: 18 },
  { i: 'blk_calendar', x: 0, y: 10, w: 8, h: 10 },
];

describe('mirrorX', () => {
  it('is cols − x − w', () => {
    assert.equal(mirrorX({ x: 0, w: 4 }, 12), 8);
    assert.equal(mirrorX({ x: 8, w: 4 }, 12), 0);
    assert.equal(mirrorX({ x: 3, w: 2 }, 8), 3);
    assert.equal(mirrorX({ x: 0, w: 12 }, 12), 0);
    assert.equal(mirrorX({ x: 0, w: 1 }, 1), 0);
  });
});

describe('mirrorLayout', () => {
  it('mirrors x only, keeping everything else', () => {
    assert.deepEqual(mirrorLayout(lg, GRID_COLS.lg), [
      { i: 'blk_area', x: 0, y: 0, w: 12, h: 2 },
      { i: 'blk_clock', x: 8, y: 2, w: 4, h: 8 },
      { i: 'blk_donut', x: 4, y: 2, w: 4, h: 8 },
      { i: 'blk_deadlines', x: 0, y: 2, w: 4, h: 18 },
      { i: 'blk_calendar', x: 4, y: 10, w: 8, h: 10 },
    ]);
  });

  it('round-trips every breakpoint: mirroring twice is the stored layout', () => {
    const md = [
      { i: 'a', x: 0, y: 0, w: 5, h: 2 },
      { i: 'b', x: 5, y: 0, w: 3, h: 2 },
    ];
    const sm = [{ i: 'a', x: 0, y: 0, w: 1, h: 2 }];
    assert.deepEqual(mirrorLayout(mirrorLayout(lg, 12), 12), lg);
    assert.deepEqual(mirrorLayout(mirrorLayout(md, 8), 8), md);
    assert.deepEqual(mirrorLayout(mirrorLayout(sm, 1), 1), sm);
  });

  it('turns a drag on the mirrored grid back into stored (left-to-right) positions', () => {
    // Shown in RTL, the clock (stored x 0) sits on the right: x' 8.
    const shown = mirrorLayout(lg, 12);
    // Dragged to the far left of the screen, x' 0 …
    const dragged = shown.map((item) => (item.i === 'blk_clock' ? { ...item, x: 0 } : item));
    // … it is stored at the end of the row.
    const stored = mirrorLayout(dragged, 12).find((item) => item.i === 'blk_clock');
    assert.deepEqual(stored, { i: 'blk_clock', x: 8, y: 2, w: 4, h: 8 });
  });

  it('turns a resize from the bottom-left handle back into growth toward the end', () => {
    // RTL resize handle: its west edge moves left, so x' shrinks as w grows; the east edge stays.
    const shown = mirrorLayout(lg, 12);
    const resized = shown.map((item) =>
      item.i === 'blk_clock' ? { ...item, x: item.x - 2, w: item.w + 2 } : item,
    );
    const stored = mirrorLayout(resized, 12).find((item) => item.i === 'blk_clock');
    assert.deepEqual(stored, { i: 'blk_clock', x: 0, y: 2, w: 6, h: 8 });
  });

  it('does not change its input', () => {
    const copy = structuredClone(lg);
    mirrorLayout(lg, 12);
    assert.deepEqual(lg, copy);
  });
});
