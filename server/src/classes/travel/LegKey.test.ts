/**
 * LegKey: one leg per (owner, anchor item, the occurrence's original start, direction), as text
 * (plan Ruling 9). It reads back what it writes, and two members' legs to one anchor never share
 * a key.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { LegKey } from './LegKey.js';

const OCCURRENCE = '2026-11-18T08:00:00.000Z';

describe('LegKey', () => {
  it('round trip', () => {
    const key = LegKey.of({
      ownerUserId: 'u-1',
      anchorItemId: 'item-1',
      occurrence: OCCURRENCE,
      direction: 'there',
    });
    const text = key.toString();
    assert.equal(text, `u-1|item-1|${OCCURRENCE}|there`);
    const parsed = LegKey.parse(text);
    assert.ok(parsed.equals(key));
    assert.equal(parsed.toString(), text);
    assert.equal(parsed.ownerUserId, 'u-1');
    assert.equal(parsed.anchorItemId, 'item-1');
    assert.equal(parsed.occurrence, OCCURRENCE);
    assert.equal(parsed.direction, 'there');
    assert.equal(parsed.anchorKey, `item-1|${OCCURRENCE}`);
    assert.equal(String(LegKey.of({ ...parts(), occurrence: 'single' })), 'u-1|item-1|single|back');
  });

  it('the owner is part of the key', () => {
    const mine = LegKey.of({ ...parts(), ownerUserId: 'u-1' });
    const theirs = LegKey.of({ ...parts(), ownerUserId: 'u-2' });
    assert.notEqual(mine.toString(), theirs.toString());
    assert.equal(mine.equals(theirs), false);
    // One anchor, so one fate: the anchor key leaves the owner out.
    assert.equal(mine.anchorKey, theirs.anchorKey);
  });

  it('refuses text that is not a key, and parts that would break one', () => {
    for (const text of ['', 'u-1|item-1|single', 'u-1|item-1|single|sideways', 'u|i||there']) {
      assert.throws(() => LegKey.parse(text));
      assert.equal(LegKey.tryParse(text), null);
    }
    assert.throws(() => LegKey.of({ ...parts(), anchorItemId: 'a|b' }));
    assert.throws(() => LegKey.of({ ...parts(), ownerUserId: '' }));
  });

  it('is immutable', () => {
    assert.ok(Object.isFrozen(LegKey.of(parts())));
  });
});

function parts(): Parameters<typeof LegKey.of>[0] {
  return { ownerUserId: 'u-1', anchorItemId: 'item-1', occurrence: 'single', direction: 'back' };
}
