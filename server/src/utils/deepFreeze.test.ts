import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { deepFreeze } from './deepFreeze.js';

describe('deepFreeze', () => {
  it('freezes every object and array at every depth, and answers the same value', () => {
    const value = { a: { b: [1, { c: 'x' }] }, d: new Date(0) };
    assert.equal(deepFreeze(value), value);
    for (const inner of [value, value.a, value.a.b, value.a.b[1], value.d]) {
      assert.equal(Object.isFrozen(inner), true);
    }
    assert.throws(() => {
      (value.a.b[1] as { c: string }).c = 'y';
    }, TypeError);
    // A Date's time is its internal slot: frozen, it still reads.
    assert.equal(value.d.getTime(), 0);
  });

  it('walks into an object that was frozen shallowly, so nothing under it stays writable', () => {
    const inner = { n: 1 };
    const shallow = Object.freeze({ inner });
    deepFreeze({ shallow });
    assert.equal(Object.isFrozen(inner), true);
  });

  it('ends on a cycle, and leaves primitives, null and undefined as they are', () => {
    const cycle: { self?: unknown; list: unknown[] } = { list: [] };
    cycle.self = cycle;
    cycle.list.push(cycle);
    assert.equal(deepFreeze(cycle), cycle);
    assert.equal(Object.isFrozen(cycle.list), true);
    for (const primitive of [1, 'text', true, null, undefined]) {
      assert.equal(deepFreeze(primitive), primitive);
    }
  });
});
