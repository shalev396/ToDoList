import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { areasAt, type AreaSpan } from './areaHit.ts';

const at = (hour: number, minute = 0): Date => new Date(Date.UTC(2026, 10, 12, hour, minute));
const area = (key: string, from: Date, to: Date | null): AreaSpan => ({
  key,
  start: from,
  end: to,
});
const keys = (found: readonly AreaSpan[]): string[] => found.map((a) => a.key);

const braude = area('braude', at(8, 30), at(15));
const study = area('study', at(13), at(17));
const open = area('open', at(9), null);

describe('areasAt', () => {
  it('a slot inside an area is covered by it', () => {
    assert.deepEqual(keys(areasAt([braude], at(10), at(10, 30))), ['braude']);
  });

  it('a slot outside every area is covered by none', () => {
    assert.deepEqual(areasAt([braude, study], at(7), at(7, 30)), []);
    assert.deepEqual(areasAt([braude, study], at(18), at(18, 30)), []);
  });

  it('touching at an edge is not covering', () => {
    assert.deepEqual(areasAt([braude], at(8), at(8, 30)), []);
    assert.deepEqual(areasAt([braude], at(15), at(15, 30)), []);
  });

  it('a slot that only partly overlaps an area is covered', () => {
    assert.deepEqual(keys(areasAt([braude], at(8), at(9))), ['braude']);
    assert.deepEqual(keys(areasAt([braude], at(14, 30), at(15, 30))), ['braude']);
  });

  it('two areas that overlap both cover their common time, earliest first', () => {
    assert.deepEqual(keys(areasAt([study, braude], at(13, 30), at(14))), ['braude', 'study']);
    // Only one of them where they do not overlap.
    assert.deepEqual(keys(areasAt([study, braude], at(10), at(10, 30))), ['braude']);
    assert.deepEqual(keys(areasAt([study, braude], at(16), at(16, 30))), ['study']);
  });

  it('areas that start together are ordered by key, whatever the input order', () => {
    const b = area('b', at(9), at(10));
    const a = area('a', at(9), at(11));
    assert.deepEqual(keys(areasAt([b, a], at(9), at(9, 30))), ['a', 'b']);
    assert.deepEqual(keys(areasAt([a, b], at(9), at(9, 30))), ['a', 'b']);
  });

  it('an area without an end holds no time', () => {
    assert.deepEqual(areasAt([open], at(9, 30), at(10)), []);
  });

  it('an instant is covered from the start up to, not including, the end', () => {
    assert.deepEqual(keys(areasAt([braude], at(8, 30), at(8, 30))), ['braude']);
    assert.deepEqual(keys(areasAt([braude], at(14, 59), at(14, 59))), ['braude']);
    assert.deepEqual(areasAt([braude], at(15), at(15)), []);
    assert.deepEqual(areasAt([braude], at(8, 29), at(8, 29)), []);
  });

  it('a day-long (all-day) area covers every slot of its day', () => {
    const day = area('day', new Date(Date.UTC(2026, 10, 12)), new Date(Date.UTC(2026, 10, 13)));
    assert.deepEqual(keys(areasAt([day], at(0), at(0, 30))), ['day']);
    assert.deepEqual(keys(areasAt([day], at(23, 30), at(24))), ['day']);
    assert.deepEqual(areasAt([day], at(24), at(24, 30)), []);
  });

  it('does not change its input', () => {
    const input = [study, braude];
    areasAt(input, at(13, 30), at(14));
    assert.deepEqual(keys(input), ['study', 'braude']);
  });
});
