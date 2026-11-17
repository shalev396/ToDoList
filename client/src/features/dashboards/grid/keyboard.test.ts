import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { LayoutItem } from '@api-types/builder.ts';
import { applyGridStep, reduceGridKey, type GridKeyOptions } from './keyboard.ts';

const LG: GridKeyOptions = { cols: 12, dir: 'ltr', horizontal: true, resizable: true };
const RTL: GridKeyOptions = { ...LG, dir: 'rtl' };
const SM: GridKeyOptions = { cols: 1, dir: 'ltr', horizontal: false, resizable: false };

const key = (name: string, shiftKey = false) => ({ key: name, shiftKey });

function overlaps(a: LayoutItem, b: LayoutItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function assertValid(layout: readonly LayoutItem[], cols: number): void {
  for (const item of layout) {
    assert.deepEqual(Object.keys(item).sort(), ['h', 'i', 'w', 'x', 'y'], 'plain items only');
    assert.ok(item.x >= 0 && item.x + item.w <= cols && item.y >= 0, `${item.i} is in the grid`);
  }
  layout.forEach((a, index) => {
    for (const b of layout.slice(index + 1)) {
      assert.equal(overlaps(a, b), false, `${a.i} and ${b.i} overlap`);
    }
  });
}

function changed(result: ReturnType<typeof reduceGridKey>) {
  assert.equal(result.type, 'changed');
  return result;
}

const lone = [{ i: 'e', x: 4, y: 0, w: 4, h: 2 }];
const row = [
  { i: 'a', x: 0, y: 0, w: 4, h: 2 },
  { i: 'b', x: 4, y: 0, w: 4, h: 2 },
  { i: 'c', x: 0, y: 2, w: 8, h: 3 },
  { i: 'd', x: 8, y: 0, w: 4, h: 2 },
];

describe('reduceGridKey: moving', () => {
  it('arrows move one cell; the end arrow is the right one left-to-right', () => {
    const right = changed(reduceGridKey(lone, 'e', key('ArrowRight'), LG));
    assert.equal(right.change, 'move');
    assert.deepEqual(right.item, { i: 'e', x: 5, y: 0, w: 4, h: 2 });
    assert.deepEqual(changed(reduceGridKey(lone, 'e', key('ArrowLeft'), LG)).item.x, 3);
  });

  it('right-to-left, the arrows follow the screen: left moves toward the end (stored x + 1)', () => {
    assert.equal(changed(reduceGridKey(lone, 'e', key('ArrowLeft'), RTL)).item.x, 5);
    assert.equal(changed(reduceGridKey(lone, 'e', key('ArrowRight'), RTL)).item.x, 3);
  });

  it('clamps to the grid: no move past the start, the end or the top', () => {
    assert.deepEqual(reduceGridKey(row, 'a', key('ArrowLeft'), LG), { type: 'unchanged' });
    assert.deepEqual(reduceGridKey(row, 'd', key('ArrowRight'), LG), { type: 'unchanged' });
    assert.deepEqual(reduceGridKey(row, 'a', key('ArrowUp'), LG), { type: 'unchanged' });
    assert.deepEqual(reduceGridKey(row, 'a', key('ArrowRight'), RTL), { type: 'unchanged' });
  });

  it('a move into a neighbour pushes it away, as a drag would, and leaves no overlap', () => {
    const result = changed(reduceGridKey(row, 'a', key('ArrowRight'), LG));
    assert.deepEqual(result.item, { i: 'a', x: 1, y: 0, w: 4, h: 2 });
    assertValid(result.layout, 12);
  });

  it('down passes the block below in one press (blocks pack upward, one row would bounce)', () => {
    const result = changed(reduceGridKey(row, 'a', key('ArrowDown'), LG));
    const a = result.layout.find((item) => item.i === 'a');
    const c = result.layout.find((item) => item.i === 'c');
    assert.ok(a && c);
    assert.ok(a.y >= c.y + c.h, 'a now sits below c');
    assertValid(result.layout, 12);
  });

  it('up passes the block above in one press', () => {
    const stack = [
      { i: 'a', x: 0, y: 0, w: 4, h: 2 },
      { i: 'b', x: 0, y: 2, w: 4, h: 3 },
      { i: 'c', x: 0, y: 5, w: 4, h: 4 },
    ];
    const once = changed(reduceGridKey(stack, 'c', key('ArrowUp'), LG));
    assert.deepEqual(
      [...once.layout].sort((p, q) => p.y - q.y).map((item) => item.i),
      ['a', 'c', 'b'],
    );
    const twice = changed(reduceGridKey(once.layout, 'c', key('ArrowUp'), LG));
    assert.deepEqual(
      [...twice.layout].sort((p, q) => p.y - q.y).map((item) => item.i),
      ['c', 'a', 'b'],
    );
    assertValid(twice.layout, 12);
  });

  it('down with nothing below changes nothing: the block packs back up', () => {
    assert.deepEqual(reduceGridKey(row, 'c', key('ArrowDown'), LG), { type: 'unchanged' });
  });
});

describe('reduceGridKey: resizing', () => {
  it('Shift and the end arrow widen, Shift and the start arrow narrow', () => {
    assert.deepEqual(changed(reduceGridKey(lone, 'e', key('ArrowRight', true), LG)).item, {
      i: 'e',
      x: 4,
      y: 0,
      w: 5,
      h: 2,
    });
    assert.equal(changed(reduceGridKey(lone, 'e', key('ArrowLeft', true), LG)).item.w, 3);
    // Right-to-left the end is on the left; the stored x stays and the width grows.
    assert.deepEqual(changed(reduceGridKey(lone, 'e', key('ArrowLeft', true), RTL)).item, {
      i: 'e',
      x: 4,
      y: 0,
      w: 5,
      h: 2,
    });
  });

  it('Shift and down or up change the height', () => {
    assert.equal(changed(reduceGridKey(lone, 'e', key('ArrowDown', true), LG)).item.h, 3);
    assert.equal(changed(reduceGridKey(lone, 'e', key('ArrowUp', true), LG)).item.h, 1);
  });

  it('clamps: never wider than the row, never smaller than the minimum', () => {
    assert.deepEqual(reduceGridKey(row, 'd', key('ArrowRight', true), LG), {
      type: 'unchanged',
    });
    const min = { ...LG, minSize: () => ({ w: 4, h: 2 }) };
    assert.deepEqual(reduceGridKey(lone, 'e', key('ArrowLeft', true), min), { type: 'unchanged' });
    assert.deepEqual(reduceGridKey(lone, 'e', key('ArrowUp', true), min), { type: 'unchanged' });
    const tiny = [{ i: 't', x: 0, y: 0, w: 1, h: 1 }];
    assert.deepEqual(reduceGridKey(tiny, 't', key('ArrowLeft', true), LG), { type: 'unchanged' });
    assert.deepEqual(reduceGridKey(tiny, 't', key('ArrowUp', true), LG), { type: 'unchanged' });
  });

  it('a block already below its minimum is never grown by a narrowing key', () => {
    const small = [{ i: 's', x: 0, y: 0, w: 2, h: 2 }];
    const min = { ...LG, minSize: () => ({ w: 4, h: 4 }) };
    assert.deepEqual(reduceGridKey(small, 's', key('ArrowLeft', true), min), {
      type: 'unchanged',
    });
  });

  it('growing into a neighbour pushes it down', () => {
    const result = changed(reduceGridKey(row, 'a', key('ArrowRight', true), LG));
    assert.equal(result.item.w, 5);
    assertValid(result.layout, 12);
  });
});

describe('reduceGridKey: phones (one column, reorder only)', () => {
  const stack = [
    { i: 'a', x: 0, y: 0, w: 1, h: 2 },
    { i: 'b', x: 0, y: 2, w: 1, h: 3 },
  ];

  it('up and down reorder', () => {
    const down = changed(reduceGridKey(stack, 'a', key('ArrowDown'), SM));
    assert.deepEqual(down.layout, [
      { i: 'a', x: 0, y: 3, w: 1, h: 2 },
      { i: 'b', x: 0, y: 0, w: 1, h: 3 },
    ]);
    const up = changed(reduceGridKey(stack, 'b', key('ArrowUp'), SM));
    assert.deepEqual(up.layout, down.layout);
  });

  it('sideways moves and resizing do nothing', () => {
    for (const event of [
      key('ArrowLeft'),
      key('ArrowRight'),
      key('ArrowDown', true),
      key('ArrowRight', true),
    ]) {
      assert.deepEqual(reduceGridKey(stack, 'a', event, SM), { type: 'unchanged' }, event.key);
    }
  });
});

describe('reduceGridKey: other keys', () => {
  it('Enter opens the block’s menu', () => {
    assert.deepEqual(reduceGridKey(row, 'a', key('Enter'), LG), { type: 'menu' });
  });

  it('lets every other key, and arrows with a modifier, through', () => {
    for (const event of [key('Tab'), key(' '), key('a'), key('Escape')]) {
      assert.deepEqual(reduceGridKey(row, 'a', event, LG), { type: 'ignored' }, event.key);
    }
    for (const modifier of ['ctrlKey', 'metaKey', 'altKey'] as const) {
      assert.deepEqual(
        reduceGridKey(row, 'b', { key: 'ArrowRight', shiftKey: false, [modifier]: true }, LG),
        { type: 'ignored' },
      );
    }
  });

  it('ignores a block that is not in the layout', () => {
    assert.deepEqual(reduceGridKey(row, 'zz', key('ArrowRight'), LG), { type: 'unchanged' });
  });

  it('keeps the input as it was and the items in their order', () => {
    const copy = structuredClone(row);
    const result = changed(reduceGridKey(row, 'a', key('ArrowDown'), LG));
    assert.deepEqual(row, copy);
    assert.deepEqual(
      result.layout.map((item) => item.i),
      row.map((item) => item.i),
    );
  });
});

describe('applyGridStep (the block menu’s Move and Resize)', () => {
  it('moves and resizes by logical steps, with the same clamps', () => {
    assert.equal(changed(applyGridStep(lone, 'e', { kind: 'move', dx: 1, dy: 0 }, LG)).item.x, 5);
    assert.equal(changed(applyGridStep(lone, 'e', { kind: 'resize', dw: 0, dh: 1 }, LG)).item.h, 3);
    assert.deepEqual(applyGridStep(row, 'a', { kind: 'move', dx: -1, dy: 0 }, LG), {
      type: 'unchanged',
    });
  });
});
