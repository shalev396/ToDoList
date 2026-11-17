import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { exactRuleFor, sameRuleMatch } from './topicRules.js';

const RULES = [
  { match: 'shalev396/*', topicId: 'p' },
  { match: 'Braude', topicId: 'c' },
  { match: 'Calc. (I) [2026]', topicId: 'w' },
];

describe('exactRuleFor', () => {
  it('finds the rule whose match equals the key, ignoring case', () => {
    assert.deepEqual(exactRuleFor(RULES, 'braude'), { match: 'Braude', topicId: 'c' });
    assert.deepEqual(exactRuleFor(RULES, 'BRAUDE'), { match: 'Braude', topicId: 'c' });
  });

  it('is not a glob match: a broader rule is not this container’s own', () => {
    assert.equal(exactRuleFor(RULES, 'shalev396/Elytra'), null);
    assert.equal(exactRuleFor(RULES, 'Braude 2'), null);
  });

  it('reads characters that are regex syntax literally', () => {
    assert.equal(exactRuleFor(RULES, 'calc. (i) [2026]')?.topicId, 'w');
    assert.equal(exactRuleFor(RULES, 'Calc X (I) [2026]'), null);
  });

  it('a * in a name stays a glob: only the same text finds the rule', () => {
    const rules = [{ match: 'Q1 *', topicId: 'w' }];
    assert.equal(exactRuleFor(rules, 'Q1 *')?.topicId, 'w');
    assert.equal(exactRuleFor(rules, 'Q1 plan'), null);
  });

  it('is null without rules', () => {
    assert.equal(exactRuleFor([], 'x'), null);
  });
});

describe('sameRuleMatch', () => {
  it('ignores case and surrounding spaces', () => {
    assert.equal(sameRuleMatch(' Braude ', 'braude'), true);
    assert.equal(sameRuleMatch('Braude', 'Braud'), false);
  });
});
