import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { AttributeDef } from '@api-types/attributes.ts';
import {
  clampWeight,
  configOf,
  configToStore,
  isDefaultConfig,
  weightsShown,
  withPreset,
  withWeight,
} from './importanceModel.ts';

const STARS: AttributeDef = { key: 'stars', name: 'Stars', type: 'rating', builtIn: false };
const NOTE: AttributeDef = { key: 'memo', name: 'Memo', type: 'text', builtIn: false };
const IMPORTANCE: AttributeDef = {
  key: 'importance',
  name: 'Importance',
  type: 'rating',
  builtIn: true,
};
const ATTRS = [IMPORTANCE, STARS, NOTE];

describe('importance settings model', () => {
  it('a page without a preset is Weighted with the defaults: 3, 4, 3, 1 and custom 0', () => {
    const shown = weightsShown(configOf(null), ATTRS);
    assert.deepEqual(
      shown.map(({ key, weight }) => [key, weight]),
      [
        ['priority', 3],
        ['dueSoon', 4],
        ['importance', 3],
        ['pinned', 1],
        ['attr.stars', 0],
      ],
    );
  });

  it('changes one weight, clamped to 0..10, keeping the others', () => {
    const next = withWeight(configOf(null), ATTRS, 'dueSoon', 99);
    assert.deepEqual(next, {
      preset: 'weighted',
      params: {
        weights: { priority: 3, dueSoon: 10, importance: 3, pinned: 1, 'attr.stars': 0 },
      },
    });
    assert.equal(clampWeight(-4), 0);
    assert.equal(clampWeight(2.6), 3);
    assert.equal(clampWeight(Number.NaN), 0);
  });

  it('the default stores nothing; anything else is stored', () => {
    assert.equal(isDefaultConfig(configOf(null), ATTRS), true);
    assert.equal(configToStore(configOf(null), ATTRS), null);
    assert.deepEqual(configToStore({ preset: 'fair', params: {} }, ATTRS), {
      preset: 'fair',
      params: {},
    });
    const custom = withWeight(configOf(null), ATTRS, 'attr.stars', 5);
    assert.equal(isDefaultConfig(custom, ATTRS), false);
    assert.deepEqual(configToStore(custom, ATTRS), {
      preset: 'weighted',
      params: { weights: { priority: 3, dueSoon: 4, importance: 3, pinned: 1, 'attr.stars': 5 } },
    });
    const zeroed = withWeight(configOf(null), ATTRS, 'pinned', 0);
    assert.deepEqual(configToStore(zeroed, ATTRS)?.params, {
      weights: { priority: 3, dueSoon: 4, importance: 3, pinned: 0 },
    });
  });

  it('switching presets: the others carry no weights; Weighted gets its weights back', () => {
    const weighted = withWeight(configOf(null), ATTRS, 'priority', 8);
    const fair = withPreset('fair', undefined);
    assert.deepEqual(fair, { preset: 'fair', params: {} });
    const back = withPreset(
      'weighted',
      weighted.preset === 'weighted' ? weighted.params.weights : undefined,
    );
    assert.deepEqual(back, weighted);
  });
});
