import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import type { Block, CatalogDescription, RuleGroup } from '@api-types/builder.ts';
import { canAddGroupBy, canAddRule, countRules, toggleGroupBy } from './caps.ts';
import {
  addBlockOp,
  dashboardDraftWith,
  issuesForBlock,
  draftFromBlock,
  draftFromDefaults,
  previewRequest,
  updateBlockOp,
  validateDraft,
} from './draft.ts';
import {
  fieldTypes,
  facetSelection,
  fromQueryBuilder,
  parseList,
  propsFieldsIn,
  queryBuilderFields,
  toQueryBuilder,
  withFacetSelection,
} from './queryBuilder.ts';

const catalog = {
  fields: {
    items: [
      { field: 'status', type: 'enum', values: ['open', 'done'], operators: ['=', 'in', 'null'] },
      { field: 'priority', type: 'number', operators: ['=', '>'] },
    ],
    containers: [{ field: 'name', type: 'string', operators: ['='] }],
    dynamic: { pattern: 'x', type: 'dynamic', operators: ['=', 'contains'] },
    provider: [],
    attributes: [],
  },
  operatorsByType: {},
} as unknown as CatalogDescription;

const names = (options: unknown): string[] =>
  (options as { name: string }[]).map((option) => option.name);

const rules = (n: number): RuleGroup => ({
  combinator: 'and',
  rules: Array.from({ length: n }, () => ({ field: 'status', operator: '=', value: 'open' })),
});

describe('catalog to querybuilder fields', () => {
  it('offers only catalog fields and their operators', () => {
    const fields = queryBuilderFields(catalog, 'items');
    assert.deepEqual(
      fields.map((f) => f.name),
      ['status', 'priority'],
    );
    assert.deepEqual(names(fields[0]?.operators), ['=', 'in', 'null']);
    assert.deepEqual(names(fields[0]?.values), ['open', 'done']);
  });
  it('offers the workspace’s topics as the values of the topic field, by name', () => {
    const withTopic = {
      ...catalog,
      fields: {
        ...catalog.fields,
        items: [
          ...catalog.fields.items,
          { field: 'topic', type: 'enum' as const, operators: ['=' as const, 'in' as const] },
        ],
      },
    };
    const topics = [
      { id: 't-work', name: 'Acme' },
      { id: 't-college', name: 'לימודים' },
    ];
    const topic = queryBuilderFields(withTopic, 'items', [], topics).find(
      (f) => f.name === 'topic',
    );
    assert.deepEqual(topic?.values, [
      { name: 't-work', label: 'Acme' },
      { name: 't-college', label: 'לימודים' },
    ]);
  });
  it('switches with the source', () => {
    assert.deepEqual(
      queryBuilderFields(catalog, 'containers').map((f) => f.name),
      ['name'],
    );
  });
  it('keeps a props field a rule already uses, with the dynamic operators', () => {
    const where: RuleGroup = {
      combinator: 'and',
      rules: [{ field: 'props.grade', operator: '=', value: 1 }],
    };
    const fields = queryBuilderFields(catalog, 'items', propsFieldsIn(where));
    assert.equal(fields.at(-1)?.name, 'props.grade');
    assert.deepEqual(names(fields.at(-1)?.operators), ['=', 'contains']);
  });
});

describe('querybuilder conversion', () => {
  it('strips ids and builds typed values and lists', () => {
    const types = fieldTypes(queryBuilderFields(catalog, 'items'));
    const out = fromQueryBuilder(
      {
        id: 'g',
        combinator: 'or',
        not: false,
        rules: [
          { id: 'r1', field: 'priority', operator: '>', value: '3' },
          { id: 'r2', field: 'status', operator: 'in', value: 'open, done' },
          { id: 'r3', field: 'status', operator: 'null', value: '' },
        ],
      } as never,
      types,
    );
    assert.deepEqual(out, {
      combinator: 'or',
      rules: [
        { field: 'priority', operator: '>', value: 3 },
        { field: 'status', operator: 'in', value: ['open', 'done'] },
        { field: 'status', operator: 'null' },
      ],
    });
  });
  it('round trips an empty where', () => {
    assert.deepEqual(toQueryBuilder(undefined), { combinator: 'and', rules: [] });
    assert.deepEqual(parseList('a,, b'), ['a', 'b']);
  });
});

describe('caps', () => {
  it('counts nested rules and stops at 10', () => {
    const nested: RuleGroup = { combinator: 'and', rules: [rules(4), rules(5)] };
    assert.equal(countRules(nested), 9);
    assert.equal(canAddRule(nested), true);
    assert.equal(canAddRule({ combinator: 'and', rules: [rules(5), rules(5)] }), false);
    assert.equal(canAddRule(undefined), true);
  });
  it('allows at most 3 group-bys', () => {
    const three = toggleGroupBy(toggleGroupBy(toggleGroupBy([], 'a'), 'b'), 'c');
    assert.deepEqual(three, ['a', 'b', 'c']);
    assert.equal(canAddGroupBy(three), false);
    assert.deepEqual(toggleGroupBy(three, 'd'), three);
    assert.deepEqual(toggleGroupBy(three, 'b'), ['a', 'c']);
  });
});

const listBlock: Block = {
  id: 'blk_abc',
  type: 'list',
  title: 'Open',
  query: { source: 'items', limit: 50 },
  viz: { kind: 'list', visibleRows: 7 },
};

describe('draft to op', () => {
  it('builds add_block without an id', () => {
    const draft = draftFromDefaults({
      type: 'list',
      defaults: { query: { source: 'items', limit: 50 }, viz: { kind: 'list' } },
    });
    draft.title = 'Mine';
    assert.deepEqual(addBlockOp(draft), {
      op: 'add_block',
      block: {
        type: 'list',
        title: 'Mine',
        viz: { kind: 'list' },
        query: { source: 'items', limit: 50 },
      },
    });
  });
  it('builds update_block with only the changed fields', () => {
    const draft = draftFromBlock(listBlock);
    draft.title = 'Renamed';
    assert.deepEqual(updateBlockOp('blk_abc', draft, listBlock), {
      op: 'update_block',
      blockId: 'blk_abc',
      patch: { title: 'Renamed' },
    });
    assert.equal(updateBlockOp('blk_abc', draftFromBlock(listBlock), listBlock), null);
  });
  it('clears rules the draft dropped', () => {
    const block: Block = {
      ...listBlock,
      rules: [{ if: { field: 'status', operator: '=', value: 'open' }, then: { tone: 'warning' } }],
    };
    const draft = draftFromBlock(block);
    draft.rules = [];
    assert.deepEqual(updateBlockOp('blk_abc', draft, block), {
      op: 'update_block',
      blockId: 'blk_abc',
      patch: { rules: [] },
    });
  });
  it('validates with the shared schema', () => {
    const draft = draftFromBlock(listBlock);
    assert.deepEqual(validateDraft(draft), []);
    draft.title = 'x'.repeat(81);
    assert.equal(validateDraft(draft)[0]?.pointer, '/title');
  });
  it('previews the draft with the dashboard variables, or nothing', () => {
    const draft = draftFromBlock(listBlock);
    assert.deepEqual(previewRequest(draft, { topic: 't-work' }), {
      draft: listBlock.query,
      blockType: 'list',
      preview: true,
      vars: { '$page.topic': 't-work' },
    });
    draft.query = undefined;
    assert.equal(previewRequest(draft, {}), null);
  });
});

describe('facet multi-selects', () => {
  it('writes a top-level in rule, replaces it, and removes it when empty', () => {
    const one = withFacetSelection(undefined, 'kind', ['task'], 10);
    assert.deepEqual(one, {
      combinator: 'and',
      rules: [{ field: 'kind', operator: 'in', value: ['task'] }],
    });
    const two = withFacetSelection(one, 'kind', ['task', 'event'], 10);
    assert.deepEqual(facetSelection(two, 'kind'), ['task', 'event']);
    assert.equal(two?.rules.length, 1);
    assert.equal(withFacetSelection(two, 'kind', [], 10), undefined);
  });
  it('leaves other rules alone and refuses past the cap', () => {
    const full = rules(10);
    assert.equal(withFacetSelection(full, 'kind', ['task'], 10), full);
    const some = withFacetSelection(rules(2), 'source.provider', ['jira'], 10);
    assert.equal(some?.rules.length, 3);
  });
  it('connectors are an integrationId in rule: two accounts of one provider, both kept', () => {
    const picked = withFacetSelection(undefined, 'integrationId', ['jira-1', 'jira-2'], 10);
    assert.deepEqual(picked?.rules, [
      { field: 'integrationId', operator: 'in', value: ['jira-1', 'jira-2'] },
    ]);
    assert.deepEqual(facetSelection(picked, 'integrationId'), ['jira-1', 'jira-2']);
    assert.equal(withFacetSelection(picked, 'integrationId', [], 10), undefined);
  });
});

describe('server lint of the whole dashboard', () => {
  const dashboard = {
    title: 'D',
    scope: { topicId: null, containerId: null, page: 'topic' as const },
    vars: {},
    layouts: { lg: [], md: [], sm: [] },
    blocks: [listBlock],
  };
  it('replaces the edited block, or appends the new one', () => {
    const draft = draftFromBlock(listBlock);
    draft.title = 'New title';
    const edited = dashboardDraftWith(dashboard, draft, 'blk_abc');
    assert.equal(edited.index, 0);
    assert.equal((edited.draft['blocks'] as Block[])[0]?.title, 'New title');
    const added = dashboardDraftWith(dashboard, draft, null);
    assert.equal(added.index, 1);
    assert.equal((added.draft['blocks'] as Block[])[1]?.id, 'blk_editor_draft');
  });
  it('keeps only the issues of one block', () => {
    const issues = [
      { pointer: '/blocks/1/title' },
      { pointer: '/blocks/10/title' },
      { pointer: '/blocks/1' },
      { pointer: '' },
    ];
    assert.equal(issuesForBlock(issues, 1).length, 2);
  });
});
