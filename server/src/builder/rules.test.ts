/**
 * The catalog's and the lint's per-block rules as the pure functions they are, one by one, without
 * DocCheck or the Block classes that choose and order them (classes/dashboard/blocks/; what whole
 * documents answer is docCheck.golden.test.ts). Also: the catalog's defaults are frozen at every
 * depth, and what a caller gets from them is its own copy.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import {
  VIEW_BLOCK_TYPE,
  type Block,
  type BlockType,
  type DashboardDraft,
  type RigidViewType,
} from '../types/builder.js';
import {
  actionNameIssues,
  BLOCK_CATALOG,
  describeCatalog,
  filterVariableIssues,
  queryRuleIssues,
  vizIssues,
} from './catalog.js';
import { lintFields, lintSourceLink, lintText } from './lint.js';
import { applyOps, type ApplyOpsContext } from './ops.js';

/** A block of `type` with the catalog's defaults (a copy). */
function blockOf(type: BlockType, extra: Record<string, unknown> = {}): Block {
  return {
    id: 'blk_1',
    type,
    title: 'Any title',
    ...structuredClone(BLOCK_CATALOG[type].defaults),
    ...extra,
  } as Block;
}

const HARDCODED =
  'hard-coded text: labels come from data or i18n keys; only titles and notes hold text';
const SOURCE_LINK = 'rows always link to their source: this block cannot turn that off';

describe('the catalog rules', () => {
  it('vizIssues: the viz fits its type’s schema', () => {
    assert.deepEqual(vizIssues(blockOf('list')), []);
    assert.deepEqual(vizIssues(blockOf('list', { viz: { kind: 'kanban' } })), [
      { pointer: '/viz/kind', message: 'Invalid input: expected "list"' },
    ]);
    assert.deepEqual(vizIssues(blockOf('list', { viz: { kind: 'list', caption: 'x' } })), [
      { pointer: '/viz', message: 'Unrecognized key: "caption"' },
    ]);
  });

  it('vizIssues: a clock takes showTomorrow as a boolean, and a clock without it is unchanged', () => {
    const clock = (viz: Record<string, unknown>): Block => blockOf('clock', { viz });
    assert.deepEqual(vizIssues(clock({ kind: 'clock24', needle: 'now', showNext: true })), []);
    assert.deepEqual(vizIssues(clock({ kind: 'clock24', showTomorrow: true })), []);
    assert.deepEqual(vizIssues(clock({ kind: 'clock24', showTomorrow: false })), []);
    assert.deepEqual(vizIssues(clock({ kind: 'clock24', showTomorrow: 'yes' })), [
      { pointer: '/viz/showTomorrow', message: 'Invalid input: expected boolean, received string' },
    ]);
  });

  it('queryRuleIssues: a data block reads a query or a saved view; any other takes no query', () => {
    assert.deepEqual(queryRuleIssues(blockOf('list')), []);
    assert.deepEqual(queryRuleIssues(blockOf('list', { query: undefined })), [
      { pointer: '/query', message: 'a list block needs a query or a saved view' },
    ]);
    assert.deepEqual(
      queryRuleIssues(blockOf('list', { query: undefined, savedViewId: 'view-1' })),
      [],
    );
    assert.deepEqual(queryRuleIssues(blockOf('note')), []);
    assert.deepEqual(queryRuleIssues(blockOf('note', { query: { source: 'items' } })), [
      { pointer: '/query', message: 'a note block takes no query' },
    ]);
  });

  it('filterVariableIssues and actionNameIssues: a filter sets a variable, an action names one', () => {
    assert.deepEqual(filterVariableIssues(blockOf('filter')), []);
    assert.deepEqual(filterVariableIssues(blockOf('filter', { sets: undefined })), [
      { pointer: '/sets', message: 'a filter block sets a $page variable' },
    ]);
    assert.deepEqual(actionNameIssues(blockOf('action')), []);
    assert.deepEqual(actionNameIssues(blockOf('action', { action: undefined })), [
      { pointer: '/action', message: 'an action block names its action' },
    ]);
  });
});

describe('the lint rules', () => {
  const query = {
    source: 'items',
    where: {
      combinator: 'and',
      rules: [
        { field: 'props.apiKey', operator: 'notNull' },
        { field: 'topic', operator: '=', value: 't-gone' },
        { field: 'topic', operator: '=', value: 't-live' },
      ],
    },
  };

  it('lintFields: credential-shaped fields; a deleted page only with the workspace’s topics', () => {
    const block = blockOf('list', { query });
    const privateField = {
      code: 'private_field',
      severity: 'error',
      pointer: '/query/where/rules/0/field',
      message: 'a field that may hold a credential',
    };
    assert.deepEqual(lintFields(block, { mode: 'ui', topicIds: new Set(['t-live']) }), [
      privateField,
      {
        code: 'deleted_topic',
        severity: 'warning',
        pointer: '/query/where/rules/1/value',
        message: 'This filter names a deleted page: it matches nothing',
      },
    ]);
    assert.deepEqual(lintFields(block, { mode: 'mcp', topicIds: undefined }), [privateField]);
  });

  it('lintSourceLink: a viz option that turns the source link off, in every mode', () => {
    assert.deepEqual(lintSourceLink(blockOf('list')), []);
    assert.deepEqual(
      lintSourceLink(
        blockOf('list', { viz: { kind: 'list', showSource: false, hideSource: true } }),
      ),
      [
        {
          code: 'source_link_hidden',
          severity: 'error',
          pointer: '/viz/showSource',
          message: SOURCE_LINK,
        },
        {
          code: 'source_link_hidden',
          severity: 'error',
          pointer: '/viz/hideSource',
          message: SOURCE_LINK,
        },
      ],
    );
    assert.deepEqual(
      lintSourceLink(blockOf('list', { viz: { kind: 'list', showSource: true } })),
      [],
    );
  });

  it('lintText: free text outside the title and a note warns people and stops agents', () => {
    const block = blockOf('chart', { viz: { kind: 'donut', emptyText: 'Nothing open' } });
    const finding = { code: 'hardcoded_text', pointer: '/viz/emptyText', message: HARDCODED };
    assert.deepEqual(lintText(block, { mode: 'ui', topicIds: undefined }), [
      { code: finding.code, severity: 'warning', pointer: finding.pointer, message: HARDCODED },
    ]);
    assert.deepEqual(lintText(block, { mode: 'mcp', topicIds: undefined }), [
      { code: finding.code, severity: 'error', pointer: finding.pointer, message: HARDCODED },
    ]);
    // The catalog's own defaults, a title and a note's note are not hard-coded text.
    assert.deepEqual(lintText(blockOf('chart'), { mode: 'mcp', topicIds: undefined }), []);
    assert.deepEqual(
      lintText(blockOf('note', { title: 'Free', note: 'Free too' }), {
        mode: 'mcp',
        topicIds: undefined,
      }),
      [],
    );
  });
});

/** Whether anything in `value` (itself included) is frozen. */
function holdsFrozen(value: unknown): boolean {
  if (typeof value !== 'object' || value === null) return false;
  return Object.isFrozen(value) || Object.values(value).some(holdsFrozen);
}

describe('the catalog defaults', () => {
  it('are frozen at every depth; the viz schemas are not', () => {
    for (const [type, entry] of Object.entries(BLOCK_CATALOG)) {
      const pending: unknown[] = [entry.defaults];
      while (pending.length > 0) {
        const value = pending.pop();
        if (typeof value !== 'object' || value === null) continue;
        assert.ok(Object.isFrozen(value), type);
        pending.push(...(Object.values(value) as unknown[]));
      }
      assert.equal(Object.isFrozen(entry.vizSchema), false, type);
    }
  });

  it('what a caller gets from them is its own: describeCatalog and a new view’s block', () => {
    for (const described of describeCatalog().blockTypes) {
      assert.equal(holdsFrozen(described.defaults), false, described.type);
    }
    const page: DashboardDraft = {
      title: 'Page',
      scope: { topicId: null, containerId: null, page: 'topic', groupVar: null },
      vars: {},
      layouts: { lg: [], md: [], sm: [] },
      blocks: [],
    };
    const ctx: ApplyOpsContext = {
      // No document check here: this is about the block the op builds.
      check: (draft) => ({ draft: draft as DashboardDraft, issues: [] }),
      newBlockId: () => 'blk_new_1',
      newViewId: () => 'vw_new_1',
      templates: () => null,
    };
    for (const type of Object.keys(VIEW_BLOCK_TYPE) as RigidViewType[]) {
      const result = applyOps(page, [{ op: 'add_view', type, title: 'View' }], ctx);
      const [block] = result.next.blocks;
      assert.ok(block !== undefined, type);
      assert.equal(holdsFrozen(block), false, type);
    }
  });
});
