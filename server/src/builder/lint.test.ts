import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  BLOCK_TYPES,
  I18N_KEY_PATTERN,
  type Block,
  type BlockType,
  type DashboardDraft,
} from '../types/builder.js';
import { DocCheck } from '../classes/dashboard/DocCheck.js';
import { BLOCK_CATALOG } from './catalog.js';
import type { LintIssue, LintMode } from './lint.js';

/** A draft's lint as every write lints it: DocCheck, block by block (the Block classes). */
function lint(draft: DashboardDraft, mode: LintMode, topicIds?: ReadonlySet<string>): LintIssue[] {
  return DocCheck.instance.lint(draft, mode, topicIds);
}

function draftOf(...blocks: Block[]): DashboardDraft {
  return {
    title: 'Free text is fine here',
    scope: { topicId: null, containerId: null, page: 'topic' },
    vars: {},
    layouts: { lg: [], md: [], sm: [] },
    blocks,
  };
}

function blockOf(type: BlockType, extra: Partial<Block> = {}, index = 1): Block {
  return {
    id: `blk_${type.toLowerCase()}_${String(index)}`,
    type,
    title: 'Any title at all',
    ...BLOCK_CATALOG[type].defaults,
    ...extra,
  } as Block;
}

function summary(issues: LintIssue[]): [string, string, string][] {
  return issues.map((issue) => [issue.code, issue.severity, issue.pointer]);
}

describe('lint: a clean dashboard', () => {
  it('every catalog default lints clean in mcp mode', () => {
    const draft = draftOf(...BLOCK_TYPES.map((type, index) => blockOf(type, {}, index)));
    assert.deepEqual(lint(draft, 'mcp'), []);
  });

  it('free text in the title, block titles, note text and query values is allowed', () => {
    const draft = draftOf(
      blockOf('note', { note: 'Remember to call the dentist' }),
      blockOf('list', {
        query: {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [{ field: 'title', operator: 'contains', value: 'quarterly report' }],
          },
        },
      }),
    );
    assert.deepEqual(lint(draft, 'mcp'), []);
  });

  it('viz values the catalog allows are not text: enums, literals, catalog field paths', () => {
    const draft = draftOf(
      blockOf('chart', { viz: { kind: 'bar', legend: 'list', showTotal: false } }),
      blockOf('calendar', { viz: { kind: 'calendar', view: 'month' } }),
      blockOf('list', { viz: { kind: 'list', linkTo: 'group', visibleRows: 5 } }),
      blockOf('table', {
        viz: { kind: 'table', columns: ['dueAt', 'source.provider', 'props.sprint'] },
      }),
      blockOf('filter', { viz: { kind: 'select', field: 'containerId' } }),
    );
    assert.deepEqual(lint(draft, 'mcp'), []);
  });
});

describe('lint: connectors', () => {
  it('an integrationId in rule is data: no lint issue in mcp mode', () => {
    const block = blockOf('list', {
      query: {
        source: 'items',
        where: {
          combinator: 'and',
          rules: [{ field: 'integrationId', operator: 'in', value: ['abc-123', 'def-456'] }],
        },
        sort: [{ field: 'status', dir: 'asc' }],
      },
    });
    assert.deepEqual(lint(draftOf(block), 'mcp'), []);
  });

  it('a block’s connectors are structure, not text: no lint issue in either mode', () => {
    const block = blockOf('list', {
      query: { source: 'items' },
      connectors: ['8f2c1a3e-0000-4000-8000-000000000001', 'local'],
    });
    assert.deepEqual(lint(draftOf(block), 'mcp'), []);
    assert.deepEqual(lint(draftOf(block), 'ui'), []);
  });
});

describe('lint: hardcoded_text', () => {
  const draft = draftOf(
    blockOf('filter', { viz: { kind: 'chips', field: 'Pick a project' } }),
    blockOf('table', { viz: { kind: 'table', columns: ['dueAt', 'Due soon'] } }),
    blockOf('chart', { viz: { kind: 'donut', emptyText: 'Nothing open' } }),
  );

  it('is a warning in ui mode', () => {
    assert.deepEqual(summary(lint(draft, 'ui')), [
      ['hardcoded_text', 'warning', '/blocks/0/viz/field'],
      ['hardcoded_text', 'warning', '/blocks/1/viz/columns/1'],
      ['hardcoded_text', 'warning', '/blocks/2/viz/emptyText'],
    ]);
  });

  it('is an error in mcp mode', () => {
    assert.deepEqual(
      lint(draft, 'mcp').map((issue) => issue.severity),
      ['error', 'error', 'error'],
    );
  });

  it('never repeats the text in its message', () => {
    for (const issue of lint(draft, 'mcp')) {
      for (const text of ['Pick a project', 'Due soon', 'Nothing open']) {
        assert.ok(!issue.message.includes(text), issue.message);
      }
    }
  });
});

describe('lint: hardcoded_text covers every string outside the title and the note', () => {
  it('an i18n key is lowercase-first letters, digits, _ and . (e.g. count, badge.overdue)', () => {
    for (const key of ['count', 'late', 'badge.overdue', 'chart.empty_state', 'a1']) {
      assert.ok(I18N_KEY_PATTERN.test(key), key);
    }
    for (const text of ['Late!', 'Overdue', 'two words', 'x', 'badge-overdue', '']) {
      assert.ok(!I18N_KEY_PATTERN.test(text), text);
    }
  });

  it('a display-rule badge must be an i18n key: a warning in the UI, an error for MCP', () => {
    const badge = (text: string): DashboardDraft =>
      draftOf(
        blockOf('deadlines', {
          rules: [{ if: { field: 'dueAt', operator: '<', value: '@now' }, then: { badge: text } }],
        }),
      );
    for (const key of ['count', 'badge.overdue']) {
      assert.deepEqual(lint(badge(key), 'mcp'), [], key);
    }
    assert.deepEqual(summary(lint(badge('Late!'), 'ui')), [
      ['hardcoded_text', 'warning', '/blocks/0/rules/0/then/badge'],
    ]);
    assert.deepEqual(summary(lint(badge('Late!'), 'mcp')), [
      ['hardcoded_text', 'error', '/blocks/0/rules/0/then/badge'],
    ]);
    assert.ok(!(lint(badge('Late!'), 'mcp')[0]?.message ?? '').includes('Late!'));
  });

  it('a free-string viz option must be an i18n key; enum and field-path options keep their rules', () => {
    const draft = draftOf(
      blockOf('chart', { viz: { kind: 'donut', emptyText: 'chart.empty' } }),
      blockOf('chart', { viz: { kind: 'donut', legend: 'Left side' } }),
      blockOf('filter', { viz: { kind: 'chips', field: 'myfield' } }),
      blockOf('chart', { viz: { kind: 'donut', emptyText: 'Nothing open' } }),
    );
    assert.deepEqual(summary(lint(draft, 'mcp')), [
      // An enum option takes one of its values, i18n-shaped or not.
      ['hardcoded_text', 'error', '/blocks/1/viz/legend'],
      // A field-path option names a catalog field.
      ['hardcoded_text', 'error', '/blocks/2/viz/field'],
      ['hardcoded_text', 'error', '/blocks/3/viz/emptyText'],
    ]);
  });

  it('any other string field is held to the same rule; conditions and filter values are data', () => {
    const extra = {
      ...blockOf('list', {
        rules: [
          {
            if: { field: 'title', operator: 'contains', value: 'Quarterly report' },
            then: { tone: 'muted' },
          },
        ],
      }),
      subtitle: 'Hello world',
    } as unknown as Block;
    assert.deepEqual(summary(lint(draftOf(extra), 'ui')), [
      ['hardcoded_text', 'warning', '/blocks/0/subtitle'],
    ]);
  });
});

describe('lint: source_link_hidden', () => {
  it('flags row blocks whose viz turns the source link off, in both modes', () => {
    const draft = draftOf(
      blockOf('list', { viz: { kind: 'list', showSource: false } }),
      blockOf('deadlines', { viz: { kind: 'deadlines', hideSourceLink: true } }),
      blockOf('calendar', { viz: { kind: 'calendar', sourceLinks: false } }),
      blockOf('kanban', { viz: { kind: 'kanban', sourceLink: 'none' } }),
      blockOf('table', { viz: { kind: 'table', showSource: true } }),
      // Charts render no rows: nothing to link.
      blockOf('chart', { viz: { kind: 'donut', showSource: false } }),
    );
    for (const mode of ['ui', 'mcp'] as const) {
      assert.deepEqual(
        summary(lint(draft, mode).filter((issue) => issue.code === 'source_link_hidden')),
        [
          ['source_link_hidden', 'error', '/blocks/0/viz/showSource'],
          ['source_link_hidden', 'error', '/blocks/1/viz/hideSourceLink'],
          ['source_link_hidden', 'error', '/blocks/2/viz/sourceLinks'],
          ['source_link_hidden', 'error', '/blocks/3/viz/sourceLink'],
        ],
        mode,
      );
    }
  });

  it('covers every row-rendering type: list, table, kanban, deadlines, calendar', () => {
    for (const type of ['list', 'table', 'kanban', 'deadlines', 'calendar'] as const) {
      const block = blockOf(type);
      const draft = draftOf({ ...block, viz: { ...block.viz, showSource: false } });
      assert.equal(lint(draft, 'ui')[0]?.code, 'source_link_hidden', type);
    }
  });
});

describe('lint: private_field', () => {
  it('flags credential-shaped field paths anywhere in a query, in both modes', () => {
    const draft = draftOf(
      blockOf('list', {
        query: {
          source: 'items',
          where: {
            combinator: 'and',
            rules: [
              { field: 'props.apiKey', operator: 'notNull' },
              {
                combinator: 'or',
                rules: [
                  { field: 'props.encoding', operator: 'notNull' },
                  { field: 'props.enc', operator: 'null' },
                ],
              },
            ],
          },
          sort: [{ field: 'props.secretNote', dir: 'asc' }],
        },
      }),
      blockOf('chart', {
        query: {
          source: 'items',
          groupBy: ['props.token'],
          aggregate: { op: 'sum', field: 'props.password' },
        },
      }),
      blockOf('deadlines', {
        rules: [{ if: { field: 'props.api-key', operator: 'notNull' }, then: { tone: 'warning' } }],
      }),
      blockOf('filter', { viz: { kind: 'chips', field: 'props.credentialId' } }),
    );
    for (const mode of ['ui', 'mcp'] as const) {
      assert.deepEqual(
        summary(lint(draft, mode)),
        [
          ['private_field', 'error', '/blocks/0/query/where/rules/0/field'],
          ['private_field', 'error', '/blocks/0/query/where/rules/1/rules/1/field'],
          ['private_field', 'error', '/blocks/0/query/sort/0/field'],
          ['private_field', 'error', '/blocks/1/query/groupBy/0'],
          ['private_field', 'error', '/blocks/1/query/aggregate/field'],
          ['private_field', 'error', '/blocks/2/rules/0/if/field'],
          ['private_field', 'error', '/blocks/3/viz/field'],
        ],
        mode,
      );
    }
  });
});

describe('lint: a filter that names a deleted page (H4)', () => {
  const alive = new Set(['t-work', 't-college']);
  const listWith = (rules: unknown[], extra: Partial<Block> = {}): Block =>
    blockOf('list', {
      query: { source: 'items', where: { combinator: 'and', rules } as never },
      ...extra,
    });

  it('warns, in both modes, on a topic id the workspace no longer has', () => {
    const draft = draftOf(listWith([{ field: 'topic', operator: '=', value: 't-gone' }]));
    for (const mode of ['ui', 'mcp'] as const) {
      const found = lint(draft, mode, alive);
      assert.deepEqual(summary(found), [
        ['deleted_topic', 'warning', '/blocks/0/query/where/rules/0/value'],
      ]);
      assert.equal(found[0]?.message, 'This filter names a deleted page: it matches nothing');
    }
  });

  it('checks every id of a list, and display rules too', () => {
    const draft = draftOf(
      listWith([{ field: 'topic', operator: 'in', value: ['t-work', 't-gone'] }], {
        rules: [
          { if: { field: 'topic', operator: '=', value: 't-gone2' }, then: { tone: 'muted' } },
        ],
      }),
    );
    assert.deepEqual(summary(lint(draft, 'ui', alive)), [
      ['deleted_topic', 'warning', '/blocks/0/query/where/rules/0/value'],
      ['deleted_topic', 'warning', '/blocks/0/rules/0/if/value'],
    ]);
  });

  it('is quiet for live topics, page variables, other fields, or when topics are unknown', () => {
    const draft = draftOf(
      listWith([
        { field: 'topic', operator: '=', value: 't-work' },
        { field: 'topic', operator: '=', value: '$page.topic' },
        { field: 'topic', operator: 'null' },
        { field: 'title', operator: '=', value: 't-gone' },
      ]),
    );
    assert.deepEqual(lint(draft, 'mcp', alive), []);
    const gone = draftOf(listWith([{ field: 'topic', operator: '=', value: 't-gone' }]));
    assert.deepEqual(lint(gone, 'mcp'), []);
  });
});
