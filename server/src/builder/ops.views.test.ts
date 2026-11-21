import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { DocCheck } from '../classes/dashboard/DocCheck.js';
import { CAPS, type Block, type DashboardDraft, type Layouts, type Op } from '../types/builder.js';
import { BLOCK_CATALOG } from './catalog.js';
import { OpValidationError } from './errors.js';
import { applyOps, type ApplyOpsContext, type ViewTemplateDraft } from './ops.js';

function emptyDraft(): DashboardDraft {
  return {
    title: 'Page',
    scope: { topicId: 't1', containerId: null, page: 'topic' },
    vars: {},
    layouts: { lg: [], md: [], sm: [] },
    blocks: [],
  };
}

function ids(prefix: string): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `${prefix}${String(n).padStart(8, '0')}`;
  };
}

const viewTemplate: ViewTemplateDraft = {
  key: 'study-dashboard@1',
  type: 'dashboard',
  title: 'Study dashboard',
  vars: { range: 'this_week' },
  blocks: [
    { id: 'blk_vt_clock', type: 'clock', title: 'Today', ...BLOCK_CATALOG.clock.defaults } as Block,
    {
      id: 'blk_vt_dead',
      type: 'deadlines',
      title: 'Deadlines',
      ...BLOCK_CATALOG.deadlines.defaults,
    } as Block,
  ],
  layouts: {
    lg: [
      { i: 'blk_vt_clock', x: 0, y: 0, w: 4, h: 8 },
      { i: 'blk_vt_dead', x: 4, y: 0, w: 4, h: 10 },
    ],
    md: [
      { i: 'blk_vt_clock', x: 0, y: 0, w: 4, h: 8 },
      { i: 'blk_vt_dead', x: 4, y: 0, w: 4, h: 10 },
    ],
    sm: [
      { i: 'blk_vt_clock', x: 0, y: 0, w: 1, h: 8 },
      { i: 'blk_vt_dead', x: 0, y: 8, w: 1, h: 10 },
    ],
  } satisfies Layouts,
};

const ctx = (): ApplyOpsContext => ({
  check: (draft) => DocCheck.instance.check(draft),
  newBlockId: ids('blk_t'),
  newViewId: ids('vw_t'),
  templates: () => null,
  viewTemplates: (key) => (key === viewTemplate.key ? structuredClone(viewTemplate) : null),
});

function head<T>(list: readonly T[] | undefined): T | undefined {
  return list?.[0];
}

function run(draft: DashboardDraft, ...ops: unknown[]): DashboardDraft {
  return applyOps(draft, ops as Op[], ctx()).next;
}

describe('views: add_view', () => {
  it('adds a rigid view with one block of its type and no layout', () => {
    const next = run(emptyDraft(), { op: 'add_view', type: 'list', title: 'My list' });
    assert.equal(next.views?.length, 1);
    const view = head(next.views);
    assert.equal(view?.type, 'list');
    assert.equal(view.title, 'My list');
    assert.equal(view.blockIds.length, 1);
    assert.equal(next.blocks[0]?.type, 'list');
    assert.equal(next.layouts.lg.length, 0);
  });

  it('maps board to a kanban block and the new types to their blocks', () => {
    const next = run(
      emptyDraft(),
      { op: 'add_view', type: 'board' },
      { op: 'add_view', type: 'timeline' },
      { op: 'add_view', type: 'agenda' },
      { op: 'add_view', type: 'workload' },
      { op: 'add_view', type: 'timesheet' },
    );
    assert.deepEqual(
      next.blocks.map((block) => block.type),
      ['kanban', 'timeline', 'agenda', 'workload', 'timesheet'],
    );
  });

  it('a Timesheet view on a topic page reads that topic: one topic rule, the page variable set', () => {
    const next = run(emptyDraft(), { op: 'add_view', type: 'timesheet' });
    const view = head(next.views);
    assert.equal(view?.type, 'timesheet');
    assert.equal(view.title, 'Timesheet');
    const block = head(next.blocks);
    assert.equal(block?.type, 'timesheet');
    assert.deepEqual(block.viz, { kind: 'timesheet', showBlocks: true });
    // The catalog's own topic rule is the one bound: never a second.
    const rules = block.query?.where?.rules ?? [];
    assert.deepEqual(
      rules.filter((rule) => 'field' in rule && rule.field === 'topic'),
      [{ field: 'topic', operator: '=', value: '$page.topic' }],
    );
    assert.deepEqual(block.query?.where, BLOCK_CATALOG.timesheet.defaults.query?.where);
    assert.deepEqual(block.listen, ['$page.range', '$page.topic']);
    assert.equal(next.vars['topic'], 't1');
    // showBlocks off, from config.
    const quiet = run(emptyDraft(), {
      op: 'add_view',
      type: 'timesheet',
      config: { viz: { showBlocks: false } },
    });
    assert.deepEqual(head(quiet.blocks)?.viz, { kind: 'timesheet', showBlocks: false });
  });

  it('a Timesheet view on the main page reads every topic: no page variable is set', () => {
    const main: DashboardDraft = {
      ...emptyDraft(),
      scope: { topicId: null, containerId: null, page: 'topic' },
    };
    const next = run(main, { op: 'add_view', type: 'timesheet' });
    assert.equal(Object.hasOwn(next.vars, 'topic'), false);
    assert.deepEqual(head(next.blocks)?.query, BLOCK_CATALOG.timesheet.defaults.query);
  });

  it('takes the sources, filter, sort and group from config', () => {
    const next = run(emptyDraft(), {
      op: 'add_view',
      type: 'list',
      config: {
        connectors: ['local'],
        query: {
          source: 'items',
          where: { combinator: 'and', rules: [{ field: 'status', operator: '=', value: 'open' }] },
          sort: [{ field: 'dueAt', dir: 'asc' }],
        },
      },
    });
    const block = head(next.blocks);
    assert.deepEqual(block?.connectors, ['local']);
    assert.equal(block.query?.sort?.[0]?.field, 'dueAt');
  });

  it('adds a blank dashboard view, and blocks to its own grid', () => {
    const first = run(emptyDraft(), { op: 'add_view', type: 'dashboard', title: 'Mine' });
    const viewId = first.views?.[0]?.id ?? '';
    const next = run(
      first,
      { op: 'add_block', block: { type: 'note' }, viewId },
      { op: 'add_block', block: { type: 'note' } },
    );
    assert.equal(next.views?.[0]?.blockIds.length, 1);
    assert.equal(next.blocks.length, 2);
    // Both blocks sit at the top left of their own grids.
    assert.deepEqual(
      next.layouts.lg.map((item) => [item.x, item.y]),
      [
        [0, 0],
        [0, 0],
      ],
    );
  });

  it('refuses a block added to a rigid view', () => {
    const first = run(emptyDraft(), { op: 'add_view', type: 'list' });
    assert.throws(
      () => run(first, { op: 'add_block', block: { type: 'note' }, viewId: first.views?.[0]?.id }),
      OpValidationError,
    );
  });

  it('adds a view from a template with fresh block ids and its template key', () => {
    const next = run(emptyDraft(), { op: 'add_view', templateKey: 'study-dashboard@1' });
    const view = head(next.views);
    assert.equal(view?.type, 'dashboard');
    assert.equal(view.templateKey, 'study-dashboard@1');
    assert.equal(view.blockIds.length, 2);
    assert.ok(next.blocks.every((block) => !block.id.startsWith('blk_vt_')));
    assert.equal(next.layouts.lg.length, 2);
  });

  it('refuses an unknown template, and a type with a templateKey', () => {
    assert.throws(() => run(emptyDraft(), { op: 'add_view', templateKey: 'nope@1' }));
    assert.throws(() =>
      run(emptyDraft(), { op: 'add_view', type: 'list', templateKey: 'study-dashboard@1' }),
    );
    assert.throws(() => run(emptyDraft(), { op: 'add_view' }));
  });
});

describe('views: the Summary stays first and fixed', () => {
  it('keeps the Summary out of views: it cannot be removed, moved or renamed', () => {
    for (const op of [
      { op: 'remove_view', viewId: 'summary' },
      { op: 'move_view', viewId: 'summary', index: 1 },
      { op: 'update_view', viewId: 'summary', title: 'x' },
    ]) {
      assert.throws(() => run(emptyDraft(), op), OpValidationError);
    }
  });

  it('keeps the Summary blocks when a view goes', () => {
    let draft = run(emptyDraft(), { op: 'add_block', block: { type: 'note' } });
    draft = run(draft, { op: 'add_view', type: 'table' });
    const viewId = draft.views?.[0]?.id ?? '';
    draft = run(draft, { op: 'remove_view', viewId });
    assert.equal(draft.blocks.length, 1);
    assert.equal(draft.views, undefined);
  });
});

describe('views: update, move, remove', () => {
  it('renames, moves and removes a view', () => {
    let draft = run(
      emptyDraft(),
      { op: 'add_view', type: 'list', title: 'A' },
      { op: 'add_view', type: 'table', title: 'B' },
      { op: 'add_view', type: 'agenda', title: 'C' },
    );
    const [a, , c] = draft.views ?? [];
    draft = run(draft, { op: 'move_view', viewId: c?.id, index: 0 });
    assert.deepEqual(
      draft.views?.map((view) => view.title),
      ['C', 'A', 'B'],
    );
    draft = run(draft, { op: 'update_view', viewId: a?.id, title: 'Renamed' });
    assert.equal(draft.views?.find((view) => view.id === a?.id)?.title, 'Renamed');
    draft = run(draft, { op: 'remove_view', viewId: a?.id });
    assert.equal(draft.views?.length, 2);
    assert.equal(draft.blocks.length, 2);
  });

  it('refuses to remove the block of a rigid view', () => {
    const draft = run(emptyDraft(), { op: 'add_view', type: 'list' });
    assert.throws(
      () => run(draft, { op: 'remove_block', blockId: draft.blocks[0]?.id }),
      OpValidationError,
    );
  });
});

describe('views: limits', () => {
  it('holds at most viewsPerPage views, the Summary included', () => {
    const ops = Array.from({ length: CAPS.maxViews - 1 }, () => ({
      op: 'add_view',
      type: 'list',
    }));
    const full = run(emptyDraft(), ...ops);
    assert.equal(full.views?.length, CAPS.maxViews - 1);
    assert.throws(() => run(full, { op: 'add_view', type: 'list' }), OpValidationError);
  });

  it('caps blocks per grid: the Summary and each dashboard view hold 40', () => {
    const first = run(emptyDraft(), { op: 'add_view', type: 'dashboard' });
    const viewId = first.views?.[0]?.id ?? '';
    const fill = (viewIdOrNone?: string): unknown[] =>
      Array.from({ length: CAPS.maxBlocks }, () => ({
        op: 'add_block',
        block: { type: 'note' },
        ...(viewIdOrNone === undefined ? {} : { viewId: viewIdOrNone }),
      }));
    const both = run(first, ...fill(), ...fill(viewId));
    assert.equal(both.blocks.length, CAPS.maxBlocks * 2);
    assert.throws(() => run(both, { op: 'add_block', block: { type: 'note' } }), OpValidationError);
    assert.throws(
      () => run(both, { op: 'add_block', block: { type: 'note' }, viewId }),
      OpValidationError,
    );
  });

  it('replace-mode apply_template keeps the views', () => {
    const draft = run(emptyDraft(), { op: 'add_view', type: 'list' });
    const withTemplate = applyOps(
      draft,
      [{ op: 'apply_template', templateKey: 't@1', mode: 'replace' }],
      {
        ...ctx(),
        templates: () => ({ ...emptyDraft(), title: 'T' }),
      },
    ).next;
    assert.equal(withTemplate.views?.length, 1);
    assert.equal(withTemplate.blocks.length, 1);
  });
});
