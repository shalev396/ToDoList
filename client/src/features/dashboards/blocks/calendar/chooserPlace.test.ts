import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { CHOOSER_GAP, chooserPlace } from './chooserPlace.ts';

const viewport = { width: 1032, height: 1376 };
const size = { width: 256, height: 140 };

describe('chooserPlace', () => {
  it('starts beside the tap, below it, so a touch’s click never lands on a row', () => {
    const place = chooserPlace({ point: { x: 300, y: 400 }, size, viewport, rtl: false });
    assert.deepEqual(place, { start: 300 + CHOOSER_GAP, top: 400 + CHOOSER_GAP });
  });

  it('measures from the right edge in a right-to-left page, so it extends leftwards', () => {
    const place = chooserPlace({ point: { x: 700, y: 400 }, size, viewport, rtl: true });
    assert.equal(place.start, 1032 - 700 + CHOOSER_GAP);
    assert.equal(place.top, 400 + CHOOSER_GAP);
  });

  it('keeps the whole menu on screen at the end side', () => {
    const ltr = chooserPlace({ point: { x: 1000, y: 100 }, size, viewport, rtl: false });
    assert.equal(ltr.start, 1032 - 256 - 8);
    const rtl = chooserPlace({ point: { x: 20, y: 100 }, size, viewport, rtl: true });
    assert.equal(rtl.start, 1032 - 256 - 8);
  });

  it('keeps a margin at the start side', () => {
    const rtl = chooserPlace({ point: { x: 1032, y: 100 }, size, viewport, rtl: true });
    assert.equal(rtl.start, CHOOSER_GAP);
    const tiny = chooserPlace({ point: { x: 0, y: 100 }, size, viewport, rtl: false });
    assert.equal(tiny.start, CHOOSER_GAP);
  });

  it('flips above the tap when there is no room below', () => {
    const place = chooserPlace({ point: { x: 300, y: 1340 }, size, viewport, rtl: false });
    assert.equal(place.top, 1340 - CHOOSER_GAP - 140);
    assert.ok(place.top + 140 <= 1376);
  });

  it('stays on screen in a viewport shorter than the menu', () => {
    const place = chooserPlace({
      point: { x: 50, y: 60 },
      size,
      viewport: { width: 400, height: 120 },
      rtl: false,
    });
    assert.equal(place.top, 8);
  });

  it('never lands the tap point inside the menu', () => {
    for (const rtl of [false, true]) {
      for (const [x, y] of [
        [10, 10],
        [500, 700],
        [1020, 1360],
        [0, 1376],
      ] as const) {
        const { start, top } = chooserPlace({ point: { x, y }, size, viewport, rtl });
        const left = rtl ? viewport.width - start - size.width : start;
        const inside = x >= left && x <= left + size.width && y >= top && y <= top + size.height;
        assert.equal(inside, false, `${String(rtl)} ${String(x)},${String(y)}`);
      }
    }
  });
});
