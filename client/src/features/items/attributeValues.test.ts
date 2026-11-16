import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AttributeDef } from '@api-types/attributes.ts';
import { dateOf, hasValue, parseOptions, shownValue, slugKey } from './attributeValues.ts';

const IMPORTANCE: AttributeDef = {
  key: 'importance',
  name: 'Importance',
  type: 'rating',
  builtIn: true,
};
const EFFORT: AttributeDef = { key: 'effort', name: 'Effort', type: 'number', builtIn: false };

describe('attribute helpers', () => {
  it('makes a key the server accepts from a name', () => {
    assert.equal(slugKey('Story size'), 'story_size');
    assert.equal(slugKey('  Effort (days)!  '), 'effort_days');
    assert.equal(slugKey('2nd review'), 'a_2nd_review');
    assert.equal(slugKey('עדיפות'), '');
    assert.equal(slugKey('x'.repeat(60)).length, 32);
  });

  it('parses one option per line without blanks or repeats', () => {
    assert.deepEqual(parseOptions(' S \n\nM\nS\nL '), ['S', 'M', 'L']);
    assert.deepEqual(parseOptions(''), []);
  });

  it('the built-in Importance shows 3 when unset, but holds no value', () => {
    assert.equal(shownValue(IMPORTANCE, {}), 3);
    assert.equal(hasValue(IMPORTANCE, {}), false);
    assert.equal(shownValue(IMPORTANCE, { importance: 5 }), 5);
    assert.equal(hasValue(IMPORTANCE, { importance: 5 }), true);
    assert.equal(shownValue(EFFORT, {}), null);
  });

  it('reads a stored date for the date input', () => {
    assert.equal(dateOf('2026-12-01T09:00:00.000Z'), '2026-12-01');
    assert.equal(dateOf(null), '');
  });
});
