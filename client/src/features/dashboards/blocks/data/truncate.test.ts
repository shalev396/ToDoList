import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { truncateText } from './truncate.ts';

describe('truncateText', () => {
  it('keeps short text and collapses whitespace', () => {
    assert.equal(truncateText('  a \n b ', 10), 'a b');
  });
  it('cuts at the limit with an ellipsis', () => {
    assert.equal(truncateText('abcdefghij', 5), 'abcd…');
  });
  it('never splits an emoji sequence', () => {
    const family = '\u{1F468}‍\u{1F469}‍\u{1F467}';
    assert.equal(truncateText(family.repeat(4), 3), `${family}${family}…`);
  });
  it('handles Hebrew and mixed direction', () => {
    assert.equal(truncateText('שלום עולם hello', 6), 'שלום…');
  });
  it('bounds a 300-character title', () => {
    assert.equal(Array.from(truncateText('א'.repeat(300), 120)).length, 120);
  });
});
