import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { resolveCandidateQuery, type RuleGroupType } from 'react-querybuilder';

import type { RuleGroup } from '@api-types/builder.ts';
import { builderGroup, toQueryBuilder } from './queryBuilder.ts';

const WHERE: RuleGroup = {
  combinator: 'and',
  rules: [
    { field: 'status', operator: '!=', value: 'done' },
    { field: 'priority', operator: '>=', value: 'high' },
  ],
};

/** The ids react-querybuilder keys the rows of a group by, as it resolves one on a render. */
function rowIds(group: RuleGroupType): string[] {
  const resolved = resolveCandidateQuery({ query: group, fallbackQuery: group });
  return resolved.rules.map((rule) => (typeof rule === 'string' ? rule : String(rule.id)));
}

describe('the group the rule tree is given', () => {
  it('an id-less group gets new row ids on every render (why the builder needs its own copy)', () => {
    const plain = toQueryBuilder(WHERE);
    assert.notDeepEqual(rowIds(plain), rowIds(plain));
  });

  it('gives a where it has not seen ids once, and the same ids on every later render', () => {
    const group = builderGroup(WHERE, null);
    assert.deepEqual(rowIds(group), rowIds(group));
    assert.ok(rowIds(group).every((id) => id !== 'undefined'));
  });

  it("hands back the builder's own group, ids and all, for the where built from its change", () => {
    const own = builderGroup(WHERE, null);
    const where: RuleGroup = { combinator: 'and', rules: [...WHERE.rules] };
    assert.equal(builderGroup(where, { where, group: own }), own);
  });

  it('a where changed elsewhere (undo, the sentence editor) is not the copy', () => {
    const own = builderGroup(WHERE, null);
    const elsewhere: RuleGroup = { combinator: 'or', rules: WHERE.rules.slice(0, 1) };
    const group = builderGroup(elsewhere, { where: WHERE, group: own });
    assert.notEqual(group, own);
    assert.equal(group.combinator, 'or');
    assert.equal(group.rules.length, 1);
  });

  it('an empty filter is the copy too, when the builder emptied it', () => {
    const own = builderGroup(undefined, null);
    assert.equal(builderGroup(undefined, { where: undefined, group: own }), own);
    assert.deepEqual(own.rules, []);
  });
});
