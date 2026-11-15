import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { applyPatch } from 'rfc6902';

import {
  BLOCK_TYPES,
  type Block,
  type BlockType,
  type DashboardDraft,
  type LayoutItem,
  type Op,
  type Rule,
  type RuleGroup,
} from '../types/builder.js';
import { BLOCK_CATALOG } from './catalog.js';
import { compileQuery } from './compile.js';
import { OpValidationError } from './errors.js';
import {
  BREAKPOINTS,
  GRID_COLUMNS,
  applyOps,
  newBlockId,
  summarizeOps,
  type ApplyOpsContext,
  type TemplateLookup,
} from './ops.js';

// ─── Fixtures ───────────────────────────────────────────────────────────────

function emptyDraft(): DashboardDraft {
  return {
    title: 'Dashboard',
    scope: { topicId: null, containerId: null, page: 'topic' },
    vars: { range: 'this_week' },
    layouts: { lg: [], md: [], sm: [] },
    blocks: [],
  };
}

/** Deterministic ids: blk_t000000001, blk_t000000002, … */
function counter(): () => string {
  let n = 0;
  return () => {
    n += 1;
    return `blk_t${String(n).padStart(9, '0')}`;
  };
}

const TEMPLATE: DashboardDraft = {
  title: 'Template',
  scope: { topicId: 'work', containerId: null, page: 'topic' },
  vars: { range: 'next_7d', provider: null },
  layouts: {
    lg: [
      { i: 'blk_tpl_chart', x: 0, y: 0, w: 6, h: 8 },
      { i: 'blk_tpl_deadlines', x: 6, y: 0, w: 6, h: 8 },
    ],
    md: [
      { i: 'blk_tpl_chart', x: 0, y: 0, w: 4, h: 8 },
      { i: 'blk_tpl_deadlines', x: 4, y: 0, w: 4, h: 8 },
    ],
    sm: [
      { i: 'blk_tpl_chart', x: 0, y: 0, w: 1, h: 8 },
      { i: 'blk_tpl_deadlines', x: 0, y: 8, w: 1, h: 8 },
    ],
  },
  blocks: [
    {
      id: 'blk_tpl_chart',
      type: 'chart',
      title: 'Open',
      ...BLOCK_CATALOG.chart.defaults,
    } as Block,
    {
      id: 'blk_tpl_deadlines',
      type: 'deadlines',
      title: 'Deadlines',
      ...BLOCK_CATALOG.deadlines.defaults,
    } as Block,
  ],
};

const templates: TemplateLookup = (key) => (key === 'tpl@1' ? structuredClone(TEMPLATE) : null);

function ctx(): ApplyOpsContext {
  return { newBlockId: counter(), templates };
}

function add(type: BlockType, extra: Record<string, unknown> = {}): Op {
  const op: unknown = { op: 'add_block', block: { type, ...extra } };
  return op as Op;
}

/** Applies ops to the draft; the next draft. */
function run(draft: DashboardDraft, ...ops: Op[]): DashboardDraft {
  return applyOps(draft, ops, ctx()).next;
}

function block(draft: DashboardDraft, id: string): Block {
  const found = draft.blocks.find((entry) => entry.id === id);
  assert.ok(found, `no block ${id}`);
  return found;
}

function blockOfType(draft: DashboardDraft, type: BlockType): Block {
  const found = draft.blocks.find((entry) => entry.type === type);
  assert.ok(found, `no ${type} block`);
  return found;
}

function refuses(draft: DashboardDraft, ops: Op[], pointer: string | RegExp): OpValidationError {
  try {
    applyOps(draft, ops, ctx());
  } catch (error) {
    assert.ok(error instanceof OpValidationError, String(error));
    if (typeof pointer === 'string') assert.equal(error.pointer, pointer, error.message);
    else assert.match(error.pointer, pointer, error.message);
    return error;
  }
  assert.fail(`applied ops that should fail at ${String(pointer)}`);
}

function overlaps(a: LayoutItem, b: LayoutItem): boolean {
  return a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
}

function assertNoOverlap(items: readonly LayoutItem[], label: string): void {
  items.forEach((a, index) => {
    for (const b of items.slice(index + 1)) {
      assert.ok(!overlaps(a, b), `${label}: ${a.i} overlaps ${b.i}`);
    }
  });
}

/** A dashboard with a chart, a filter, a calendar and deadlines (ids blk_t000000001…4). */
function wired(): DashboardDraft {
  return run(emptyDraft(), add('chart'), add('filter'), add('calendar'), add('deadlines'));
}

// ─── Ids and summaries ──────────────────────────────────────────────────────

describe('newBlockId', () => {
  it('is blk_ and 10 lowercase letters or digits, fresh each time', () => {
    const ids = new Set(Array.from({ length: 2000 }, () => newBlockId()));
    assert.equal(ids.size, 2000);
    for (const id of ids) assert.match(id, /^blk_[a-z0-9]{10}$/);
  });
});

describe('summarizeOps', () => {
  it('names each op and its subject, never free text', () => {
    assert.equal(
      summarizeOps([add('deadlines', { title: 'My secret plan' })]),
      'add_block deadlines',
    );
    assert.equal(
      summarizeOps([
        { op: 'set_title', title: 'Anything' },
        { op: 'remove_block', blockId: 'blk_abc' },
        { op: 'set_view', blockId: 'blk_cal', view: 'month' },
      ]),
      'set_title, remove_block blk_abc, set_view blk_cal month',
    );
    const many = Array.from({ length: 40 }, () => add('note'));
    assert.ok(summarizeOps(many).length <= 200);
  });
});

// ─── add_block ──────────────────────────────────────────────────────────────

describe('add_block', () => {
  it('assigns a fresh id and merges the catalog defaults for the type', () => {
    const next = run(emptyDraft(), add('deadlines', { title: 'Deadlines' }));
    const [added] = next.blocks;
    assert.ok(added);
    assert.equal(added.id, 'blk_t000000001');
    assert.equal(added.type, 'deadlines');
    assert.equal(added.title, 'Deadlines');
    assert.deepEqual(added.query, BLOCK_CATALOG.deadlines.defaults.query);
    assert.deepEqual(added.viz, BLOCK_CATALOG.deadlines.defaults.viz);
  });

  it('keeps what the op gives: a query replaces the default, viz keys merge over it', () => {
    const query = { source: 'items' as const, dateRange: 'next_14d' as const };
    const next = run(
      emptyDraft(),
      add('chart', { query: { ...query, groupBy: ['topic'], aggregate: { op: 'count' } } }),
      add('deadlines', { query, viz: { kind: 'deadlines', overdueOnTop: false } }),
    );
    assert.deepEqual(blockOfType(next, 'deadlines').query, query);
    assert.deepEqual(blockOfType(next, 'deadlines').viz, {
      kind: 'deadlines',
      overdueOnTop: false,
    });
    assert.deepEqual(blockOfType(next, 'chart').viz, BLOCK_CATALOG.chart.defaults.viz);
    assert.equal(blockOfType(next, 'chart').title, '');
  });

  it('a block bound to a saved view gets no default query', () => {
    const next = run(emptyDraft(), add('list', { savedViewId: 'view-1' }));
    assert.equal(blockOfType(next, 'list').query, undefined);
    assert.equal(blockOfType(next, 'list').savedViewId, 'view-1');
  });

  it('auto-places lg in the first free slot, top to bottom, left to right', () => {
    const next = run(emptyDraft(), add('chart'), add('clock'), add('counter'));
    const { lg } = next.layouts;
    assert.deepEqual(lg[0], { i: 'blk_t000000001', x: 0, y: 0, ...BLOCK_CATALOG.chart.size });
    assert.deepEqual(lg[1], { i: 'blk_t000000002', x: 4, y: 0, ...BLOCK_CATALOG.clock.size });
    assert.deepEqual(lg[2], { i: 'blk_t000000003', x: 8, y: 0, ...BLOCK_CATALOG.counter.size });
    // A full-width block goes below everything; a small one fills the hole under the counter.
    const more = run(next, add('table'), add('action'));
    assert.deepEqual(more.layouts.lg.slice(3), [
      { i: 'blk_t000000004', x: 0, y: 8, ...BLOCK_CATALOG.table.size },
      { i: 'blk_t000000005', x: 8, y: 4, ...BLOCK_CATALOG.action.size },
    ]);
    assertNoOverlap(more.layouts.lg, 'lg');
  });

  it('places md on 8 columns with the width scaled, and stacks sm in one column', () => {
    const next = run(emptyDraft(), add('calendar'), add('deadlines'), add('note'));
    const scaled = (w: number): number => Math.max(1, Math.round((w * GRID_COLUMNS.md) / 12));
    next.blocks.forEach((entry, index) => {
      const { size } = BLOCK_CATALOG[entry.type];
      const md = next.layouts.md[index];
      const sm = next.layouts.sm[index];
      assert.equal(md?.i, entry.id);
      assert.equal(md.w, scaled(size.w));
      assert.equal(md.h, size.h);
      assert.ok(md.x + md.w <= GRID_COLUMNS.md);
      assert.equal(sm?.i, entry.id);
      assert.deepEqual({ x: sm.x, w: sm.w, h: sm.h }, { x: 0, w: 1, h: size.h });
    });
    const smYs = next.layouts.sm.map((item) => item.y);
    assert.deepEqual(smYs, [0, BLOCK_CATALOG.calendar.size.h, BLOCK_CATALOG.calendar.size.h + 10]);
  });

  it('auto-placement never overlaps, whatever is added', () => {
    let draft = emptyDraft();
    const types = [...BLOCK_TYPES, ...BLOCK_TYPES, ...BLOCK_TYPES].slice(0, 30);
    for (const type of types) draft = run(draft, add(type));
    for (const bp of BREAKPOINTS) {
      assert.equal(draft.layouts[bp].length, 30);
      assertNoOverlap(draft.layouts[bp], bp);
      for (const item of draft.layouts[bp]) assert.ok(item.x + item.w <= GRID_COLUMNS[bp], bp);
    }
  });

  it('uses a given position as is; other breakpoints follow its size', () => {
    const next = run(emptyDraft(), add('chart'), {
      op: 'add_block',
      block: { type: 'deadlines' },
      layout: { lg: { x: 0, y: 20, w: 12, h: 6 } },
    });
    assert.deepEqual(next.layouts.lg[1], { i: 'blk_t000000002', x: 0, y: 20, w: 12, h: 6 });
    assert.deepEqual(next.layouts.md[1], { i: 'blk_t000000002', x: 0, y: 8, w: 8, h: 6 });
    assert.deepEqual(next.layouts.sm[1], { i: 'blk_t000000002', x: 0, y: 8, w: 1, h: 6 });
  });

  it('never reuses an id that is taken', () => {
    const draft = run(emptyDraft(), add('note'));
    let calls = 0;
    const result = applyOps(draft, [add('note')], {
      templates,
      newBlockId: () => {
        calls += 1;
        return calls === 1 ? 'blk_t000000001' : 'blk_fresh0001';
      },
    });
    assert.deepEqual(
      result.next.blocks.map((entry) => entry.id),
      ['blk_t000000001', 'blk_fresh0001'],
    );
  });
});

// ─── update_block, remove_block, arrange ────────────────────────────────────

describe('update_block', () => {
  it('replaces the fields it names; viz keys merge, and null removes one', () => {
    const draft = run(emptyDraft(), add('calendar'));
    const next = run(draft, {
      op: 'update_block',
      blockId: 'blk_t000000001',
      patch: {
        title: 'Week',
        query: { source: 'items', dateRange: 'this_week' },
        viz: { view: 'month', allowMonth: null },
      },
    });
    const calendar = block(next, 'blk_t000000001');
    assert.equal(calendar.title, 'Week');
    assert.deepEqual(calendar.query, { source: 'items', dateRange: 'this_week' });
    assert.deepEqual(calendar.viz, { kind: 'calendar', view: 'month' });
    assert.deepEqual(calendar.listen, BLOCK_CATALOG.calendar.defaults.listen);
  });

  it('connectors: null takes the field off (every source); [] reads none; an edit ends sourceRemoved', () => {
    const draft = run(emptyDraft(), add('list'));
    const id = 'blk_t000000001';
    const none = run(draft, { op: 'update_block', blockId: id, patch: { connectors: [] } });
    assert.deepEqual(block(none, id).connectors, []);
    // Stop sharing marks a block it emptied; any later edit of the block ends the notice.
    const marked = {
      ...none,
      blocks: none.blocks.map((entry) => ({ ...entry, sourceRemoved: true as const })),
    };
    const all = run(marked, { op: 'update_block', blockId: id, patch: { connectors: null } });
    assert.equal('connectors' in block(all, id), false);
    assert.equal('sourceRemoved' in block(all, id), false);
    const renamed = run(marked, { op: 'update_block', blockId: id, patch: { title: 'Mine' } });
    assert.deepEqual(block(renamed, id).connectors, []);
    assert.equal('sourceRemoved' in block(renamed, id), false);
  });

  it('cannot change the id or the type, and needs an existing block', () => {
    const draft = run(emptyDraft(), add('note'));
    refuses(
      draft,
      [{ op: 'update_block', blockId: 'blk_t000000001', patch: { type: 'list' } } as unknown as Op],
      '/ops/0/patch',
    );
    refuses(
      draft,
      [
        {
          op: 'update_block',
          blockId: 'blk_t000000001',
          patch: { id: 'blk_other' },
        } as unknown as Op,
      ],
      '/ops/0/patch',
    );
    refuses(
      draft,
      [{ op: 'update_block', blockId: 'blk_missing', patch: { title: 'x' } }],
      '/ops/0/blockId',
    );
  });

  it('validates the result: a bad viz kind points into the dashboard', () => {
    const draft = run(emptyDraft(), add('note'), add('chart'));
    refuses(
      draft,
      [{ op: 'update_block', blockId: 'blk_t000000002', patch: { viz: { kind: 'pie' } } }],
      '/blocks/1/viz/kind',
    );
  });
});

describe('remove_block', () => {
  it('removes the block and its layout entries from every breakpoint', () => {
    const draft = wired();
    const next = run(draft, { op: 'remove_block', blockId: 'blk_t000000002' });
    assert.deepEqual(
      next.blocks.map((entry) => entry.id),
      ['blk_t000000001', 'blk_t000000003', 'blk_t000000004'],
    );
    for (const bp of BREAKPOINTS) {
      assert.ok(!next.layouts[bp].some((item) => item.i === 'blk_t000000002'), bp);
      assert.equal(next.layouts[bp].length, 3);
    }
    refuses(draft, [{ op: 'remove_block', blockId: 'blk_missing' }], '/ops/0/blockId');
  });

  it('warns when blocks still listen to a variable nothing sets any more', () => {
    const draft = run(wired(), {
      op: 'connect_blocks',
      fromBlockId: 'blk_t000000002',
      variable: '$page.topic',
      toBlockIds: ['blk_t000000004'],
    });
    const result = applyOps(draft, [{ op: 'remove_block', blockId: 'blk_t000000002' }], ctx());
    assert.equal(result.warnings.length, 1);
    assert.match(result.warnings[0] ?? '', /\$page\.topic/);
    assert.match(result.warnings[0] ?? '', /blk_t000000004/);
  });
});

describe('arrange', () => {
  it('sets the positions it names and keeps the others', () => {
    const draft = wired();
    const next = run(draft, {
      op: 'arrange',
      layouts: {
        lg: [
          { i: 'blk_t000000003', x: 0, y: 0, w: 12, h: 12 },
          { i: 'blk_t000000001', x: 0, y: 12, w: 6, h: 6 },
        ],
      },
    });
    assert.deepEqual(
      next.layouts.lg.find((item) => item.i === 'blk_t000000003'),
      {
        i: 'blk_t000000003',
        x: 0,
        y: 0,
        w: 12,
        h: 12,
      },
    );
    assert.deepEqual(
      next.layouts.lg.find((item) => item.i === 'blk_t000000002'),
      draft.layouts.lg.find((item) => item.i === 'blk_t000000002'),
    );
    assert.deepEqual(next.layouts.md, draft.layouts.md);
  });

  it('refuses unknown block ids and a block placed twice', () => {
    const draft = wired();
    refuses(
      draft,
      [{ op: 'arrange', layouts: { md: [{ i: 'blk_missing', x: 0, y: 0, w: 1, h: 1 }] } }],
      '/ops/0/layouts/md/0/i',
    );
    refuses(
      draft,
      [
        {
          op: 'arrange',
          layouts: {
            lg: [
              { i: 'blk_t000000001', x: 0, y: 0, w: 1, h: 1 },
              { i: 'blk_t000000001', x: 2, y: 0, w: 1, h: 1 },
            ],
          },
        },
      ],
      '/ops/0/layouts/lg/1/i',
    );
  });
});

// ─── connect_blocks ─────────────────────────────────────────────────────────

describe('connect_blocks', () => {
  const rulesOf = (entry: Block): RuleGroup['rules'] => entry.query?.where?.rules ?? [];
  const lastRule = (entry: Block): Rule => {
    const node = rulesOf(entry).at(-1);
    assert.ok(node !== undefined && !('combinator' in node), 'the last rule is a rule');
    return node;
  };

  it('a chart emits the variable; targets listen to it and filter on the field', () => {
    const next = run(wired(), {
      op: 'connect_blocks',
      fromBlockId: 'blk_t000000001',
      variable: '$page.provider',
      field: 'source.provider',
      toBlockIds: ['blk_t000000003', 'blk_t000000004', 'blk_t000000004'],
    });
    assert.deepEqual(block(next, 'blk_t000000001').emits, { onSegmentClick: '$page.provider' });
    const calendar = block(next, 'blk_t000000003');
    assert.deepEqual(calendar.listen, ['$page.range', '$page.provider']);
    // The calendar's or-group is wrapped in an and-group with the binding rule.
    assert.deepEqual(calendar.query?.where, {
      combinator: 'and',
      rules: [
        BLOCK_CATALOG.calendar.defaults.query?.where,
        { field: 'source.provider', operator: '=', value: '$page.provider' },
      ],
    });
    const deadlines = block(next, 'blk_t000000004');
    assert.deepEqual(deadlines.listen, ['$page.provider']);
    assert.deepEqual(rulesOf(deadlines).at(-1), {
      field: 'source.provider',
      operator: '=',
      value: '$page.provider',
    });
  });

  it('a filter sets the variable; the field comes from the filter when not given', () => {
    const next = run(wired(), {
      op: 'connect_blocks',
      fromBlockId: 'blk_t000000002',
      variable: '$page.topic',
      toBlockIds: ['blk_t000000004'],
    });
    assert.equal(block(next, 'blk_t000000002').sets, '$page.topic');
    assert.deepEqual(rulesOf(block(next, 'blk_t000000004')).at(-1), {
      field: 'topic',
      operator: '=',
      value: '$page.topic',
    });
  });

  it('a chart without a field binds its first groupBy field', () => {
    const next = run(wired(), {
      op: 'connect_blocks',
      fromBlockId: 'blk_t000000001',
      variable: '$page.provider',
      toBlockIds: ['blk_t000000004'],
    });
    assert.deepEqual(rulesOf(block(next, 'blk_t000000004')).at(-1), {
      field: 'source.provider',
      operator: '=',
      value: '$page.provider',
    });
  });

  /** A connect_blocks op from one block to others; the field is the source's unless given. */
  const connect = (
    fromBlockId: string,
    variable: string,
    toBlockIds: string[],
    field?: string,
  ): Op => ({
    op: 'connect_blocks',
    fromBlockId,
    variable,
    toBlockIds,
    ...(field === undefined ? {} : { field }),
  });

  /** wired()'s filter (blk_t000000002) pointed at another field. */
  const filterOn = (draft: DashboardDraft, viz: Record<string, unknown>): DashboardDraft =>
    run(draft, { op: 'update_block', blockId: 'blk_t000000002', patch: { viz } });

  it('replaces only $page rules on that field: static rules stay; idempotent', () => {
    const draft = filterOn(wired(), { field: 'status' });
    const op = connect('blk_t000000002', '$page.status', ['blk_t000000004']);
    const once = run(draft, op);
    assert.deepEqual(rulesOf(block(once, 'blk_t000000004')), [
      { field: 'dueAt', operator: 'notNull' },
      { field: 'status', operator: 'in', value: ['open', 'in_progress'] },
      { field: 'status', operator: '=', value: '$page.status' },
    ]);
    assert.deepEqual(run(once, op), once);
    // Another variable on that field takes the old binding's place, in the rules and in listen.
    const rebound = run(once, connect('blk_t000000002', '$page.state', ['blk_t000000004']));
    const target = block(rebound, 'blk_t000000004');
    assert.deepEqual(rulesOf(target), [
      { field: 'dueAt', operator: 'notNull' },
      { field: 'status', operator: 'in', value: ['open', 'in_progress'] },
      { field: 'status', operator: '=', value: '$page.state' },
    ]);
    assert.deepEqual(target.listen, ['$page.state']);
  });

  it('binds lists with contains and dates with within, the operators those fields take', () => {
    const draft = run(
      wired(),
      add('filter', { viz: { kind: 'chips', field: 'labels' } }),
      add('filter', { viz: { kind: 'datePresets', field: 'dueAt' } }),
    );
    const next = run(
      draft,
      connect('blk_t000000005', '$page.label', ['blk_t000000004']),
      connect('blk_t000000006', '$page.when', ['blk_t000000004']),
    );
    // Static rules on those fields (dueAt notNull) stay.
    assert.deepEqual(rulesOf(block(next, 'blk_t000000004')), [
      { field: 'dueAt', operator: 'notNull' },
      { field: 'status', operator: 'in', value: ['open', 'in_progress'] },
      { field: 'labels', operator: 'contains', value: '$page.label' },
      { field: 'dueAt', operator: 'within', value: '$page.when' },
    ]);
  });

  it('an explicit field must be the one the source filters on', () => {
    // The filter filters on topic, the chart on source.provider (its groupBy).
    refuses(
      wired(),
      [connect('blk_t000000002', '$page.x', ['blk_t000000004'], 'status')],
      '/ops/0/field',
    );
    refuses(
      wired(),
      [connect('blk_t000000001', '$page.x', ['blk_t000000004'], 'topic')],
      '/ops/0/field',
    );
    const same = run(
      wired(),
      connect('blk_t000000002', '$page.topic', ['blk_t000000004'], 'topic'),
    );
    assert.equal(lastRule(block(same, 'blk_t000000004')).field, 'topic');
    // A chart without a groupBy has no segments to click: it sets nothing.
    const total = run(wired(), {
      op: 'update_block',
      blockId: 'blk_t000000001',
      patch: { query: { source: 'items', aggregate: { op: 'count' } }, viz: { kind: 'number' } },
    });
    refuses(
      total,
      [connect('blk_t000000001', '$page.x', ['blk_t000000004'])],
      '/ops/0/fromBlockId',
    );
  });

  it('a multi-select filter, or a variable that holds a list, binds with in', () => {
    const multi = run(
      filterOn(wired(), { kind: 'chips', field: 'source.provider', multi: true }),
      connect('blk_t000000002', '$page.providers', ['blk_t000000004']),
    );
    assert.deepEqual(rulesOf(block(multi, 'blk_t000000004')).at(-1), {
      field: 'source.provider',
      operator: 'in',
      value: '$page.providers',
    });
    const listVar = run(
      wired(),
      { op: 'set_vars', vars: { range: 'this_week', topic: ['work', 'college'] } },
      connect('blk_t000000002', '$page.topic', ['blk_t000000004']),
    );
    assert.equal(lastRule(block(listVar, 'blk_t000000004')).operator, 'in');
    // A true/false field takes one value, and a date field one range: a list can't bind them.
    refuses(
      filterOn(wired(), { kind: 'chips', field: 'overlay.pinned', multi: true }),
      [connect('blk_t000000002', '$page.pinned', ['blk_t000000004'])],
      '/ops/0/field',
    );
    refuses(
      filterOn(wired(), { kind: 'datePresets', field: 'dueAt', multi: true }),
      [connect('blk_t000000002', '$page.when', ['blk_t000000004'])],
      '/ops/0/field',
    );
  });

  it('every binding compiles and filters with its variable set (the real compiler)', () => {
    const draft = run(
      wired(),
      add('filter', { viz: { kind: 'chips', field: 'source.provider', multi: true } }),
      add('filter', { viz: { kind: 'chips', field: 'labels' } }),
      add('filter', { viz: { kind: 'datePresets', field: 'dueAt' } }),
    );
    const next = run(
      draft,
      connect('blk_t000000001', '$page.provider', ['blk_t000000004']),
      connect('blk_t000000002', '$page.topic', ['blk_t000000004']),
      connect('blk_t000000005', '$page.providers', ['blk_t000000003']),
      connect('blk_t000000006', '$page.label', ['blk_t000000003']),
      connect('blk_t000000007', '$page.when', ['blk_t000000003']),
    );
    const vars = {
      range: 'this_week',
      provider: 'jira',
      topic: 'work',
      providers: ['jira', 'linear'],
      label: 'backend',
      when: 'this_week',
    };
    const compiled = (id: string): { filter: string; applied: string[] } => {
      const target = block(next, id);
      assert.ok(target.query);
      const result = compileQuery(target.query, {
        ws: { id: 'w-1' },
        userId: 'u-1',
        access: { userId: 'u-1', integrations: [], local: 'visible' },
        vars,
        now: new Date('2026-11-11T08:00:00Z'),
        timeZone: 'Asia/Jerusalem',
        weekStart: 'sun',
        preview: false,
        blockType: target.type,
      });
      assert.deepEqual(result.warnings, [], id);
      return {
        // The query's own filter: the last $match before the facet.
        filter: JSON.stringify(result.pipeline.filter((stage) => '$match' in stage).at(-1)),
        applied: Object.keys(result.appliedVars).sort(),
      };
    };
    const deadlines = compiled('blk_t000000004');
    assert.deepEqual(deadlines.applied, ['$page.provider', '$page.topic']);
    assert.ok(deadlines.filter.includes('{"source.provider":"jira"}'), deadlines.filter);
    assert.ok(deadlines.filter.includes('{"topicId":"work"}'), deadlines.filter);
    const calendar = compiled('blk_t000000003');
    assert.deepEqual(calendar.applied, [
      '$page.label',
      '$page.providers',
      '$page.range',
      '$page.when',
    ]);
    assert.ok(
      calendar.filter.includes('{"source.provider":{"$in":["jira","linear"]}}'),
      calendar.filter,
    );
    assert.ok(calendar.filter.includes('{"labels":"backend"}'), calendar.filter);
    assert.ok(calendar.filter.includes('{"dueAt":{"$gte":'), calendar.filter);
  });

  it('wraps a negated and-group too, so the binding is never negated', () => {
    const draft = run(wired(), {
      op: 'update_block',
      blockId: 'blk_t000000004',
      patch: {
        query: {
          source: 'items',
          where: {
            combinator: 'and',
            not: true,
            rules: [{ field: 'kind', operator: '=', value: 'event' }],
          },
        },
      },
    });
    const next = run(draft, {
      op: 'connect_blocks',
      fromBlockId: 'blk_t000000002',
      variable: '$page.topic',
      toBlockIds: ['blk_t000000004'],
    });
    const where = block(next, 'blk_t000000004').query?.where;
    assert.equal(where?.combinator, 'and');
    assert.equal(where.not, undefined);
    assert.equal(where.rules.length, 2);
  });

  it('refuses a source that sets nothing, a target without a query, itself, or an unknown block', () => {
    const draft = run(wired(), add('note'));
    const connect = (fromBlockId: string, toBlockIds: string[], field?: string): Op[] => [
      {
        op: 'connect_blocks',
        fromBlockId,
        variable: '$page.topic',
        ...(field === undefined ? {} : { field }),
        toBlockIds,
      },
    ];
    refuses(draft, connect('blk_t000000003', ['blk_t000000004'], 'topic'), '/ops/0/fromBlockId');
    refuses(draft, connect('blk_t000000002', ['blk_t000000005']), '/ops/0/toBlockIds/0');
    refuses(
      draft,
      connect('blk_t000000001', ['blk_t000000001'], 'source.provider'),
      '/ops/0/toBlockIds/0',
    );
    refuses(draft, connect('blk_t000000002', ['blk_missing']), '/ops/0/toBlockIds/0');
    refuses(draft, connect('blk_missing', ['blk_t000000004']), '/ops/0/fromBlockId');
    refuses(draft, connect('blk_t000000002', ['blk_t000000004'], 'ownerUserId'), '/ops/0/field');
    // The field the filter filters on is not a field of a containers query.
    const onStatus = run(
      draft,
      { op: 'update_block', blockId: 'blk_t000000002', patch: { viz: { field: 'status' } } },
      add('list', { query: { source: 'containers' } }),
    );
    refuses(onStatus, connect('blk_t000000002', ['blk_t000000006']), '/ops/0/field');
    // A filter that names no field, and no field given: nothing to bind.
    const bare = run(draft, {
      op: 'update_block',
      blockId: 'blk_t000000002',
      patch: { viz: { field: null } },
    });
    refuses(bare, connect('blk_t000000002', ['blk_t000000004']), '/ops/0/field');
  });
});

// ─── apply_template, set_view, set_title, set_vars ──────────────────────────

describe('apply_template', () => {
  it('merge appends the blocks with fresh ids, below the existing ones', () => {
    const draft = run(emptyDraft(), add('calendar'));
    const next = run(draft, { op: 'apply_template', templateKey: 'tpl@1', mode: 'merge' });
    assert.equal(next.title, 'Dashboard');
    assert.deepEqual(
      next.blocks.map((entry) => [entry.id, entry.type]),
      [
        ['blk_t000000001', 'calendar'],
        ['blk_t000000002', 'chart'],
        ['blk_t000000003', 'deadlines'],
      ],
    );
    for (const bp of BREAKPOINTS) {
      const bottom = Math.max(...draft.layouts[bp].map((item) => item.y + item.h));
      const added = next.layouts[bp].filter((item) => item.i !== 'blk_t000000001');
      assert.equal(added.length, 2, bp);
      const original = TEMPLATE.layouts[bp];
      added.forEach((item, index) => {
        assert.equal(item.y, (original[index]?.y ?? NaN) + bottom, bp);
      });
      assertNoOverlap(next.layouts[bp], bp);
    }
    // Template vars are added; the dashboard's own values win.
    assert.deepEqual(next.vars, { range: 'this_week', provider: null });
  });

  it('replace swaps the title, vars, blocks and layouts, and keeps the scope', () => {
    const draft = run(emptyDraft(), add('calendar'));
    const next = run(draft, { op: 'apply_template', templateKey: 'tpl@1', mode: 'replace' });
    assert.equal(next.title, 'Template');
    assert.deepEqual(next.scope, draft.scope);
    assert.deepEqual(next.vars, TEMPLATE.vars);
    assert.deepEqual(
      next.blocks.map((entry) => entry.type),
      ['chart', 'deadlines'],
    );
    assert.ok(next.blocks.every((entry) => !entry.id.startsWith('blk_tpl')));
    assert.deepEqual(
      next.layouts.lg.map((item) => item.i),
      next.blocks.map((entry) => entry.id),
    );
  });

  it('refuses an unknown template', () => {
    refuses(
      emptyDraft(),
      [{ op: 'apply_template', templateKey: 'nope@1', mode: 'merge' }],
      '/ops/0/templateKey',
    );
  });
});

describe('set_view, set_title, set_vars', () => {
  it('set_view sets a calendar view; other blocks refuse it', () => {
    const draft = wired();
    const next = run(draft, { op: 'set_view', blockId: 'blk_t000000003', view: 'month' });
    assert.equal(block(next, 'blk_t000000003').viz['view'], 'month');
    refuses(draft, [{ op: 'set_view', blockId: 'blk_t000000001', view: 'list' }], '/ops/0/blockId');
  });

  it('set_title and set_vars replace the title and the whole vars map', () => {
    const next = run(
      emptyDraft(),
      { op: 'set_title', title: 'College' },
      { op: 'set_vars', vars: { course: null, range: 'this_semester' } },
    );
    assert.equal(next.title, 'College');
    assert.deepEqual(next.vars, { course: null, range: 'this_semester' });
  });
});

// ─── Validation of the result ───────────────────────────────────────────────

describe('applyOps: validating the result', () => {
  it('enforces the caps: at most 40 blocks', () => {
    let draft = emptyDraft();
    draft = run(draft, ...Array.from({ length: 40 }, () => add('note')));
    assert.equal(draft.blocks.length, 40);
    refuses(draft, [add('note')], '/blocks');
  });

  it('runs the compiler over every query: an unknown field points into the dashboard', () => {
    const draft = run(emptyDraft(), add('note'), add('list'));
    refuses(
      draft,
      [
        {
          op: 'update_block',
          blockId: 'blk_t000000002',
          patch: {
            query: {
              source: 'items',
              where: {
                combinator: 'and',
                rules: [{ field: 'ownerUserId', operator: '=', value: 'x' }],
              },
            },
          },
        },
      ],
      '/blocks/1/query/where/rules/0/field',
    );
  });

  it('refuses secret-shaped text and reserved variable names, without echoing them', () => {
    const fake = 'ghp_FAKEabcdefghijklmnopqrstuvwxyz0123';
    const error = refuses(emptyDraft(), [{ op: 'set_title', title: `see ${fake}` }], '/title');
    assert.ok(!error.message.includes(fake));
    refuses(emptyDraft(), [{ op: 'set_vars', vars: { token: 'x' } }], '/vars/token');
    refuses(emptyDraft(), [{ op: 'set_vars', vars: { apiKey: 'x' } }], '/vars/apiKey');
  });

  it('refuses a malformed op with a pointer into the op list', () => {
    refuses(
      emptyDraft(),
      [{ op: 'add_block', block: { type: 'gauge' } } as unknown as Op],
      /^\/ops\/0\/block/,
    );
    refuses(
      emptyDraft(),
      [{ op: 'set_title', title: 'Fine' }, { op: 'explode' } as unknown as Op],
      '/ops/1/op',
    );
  });

  it('an invalid op leaves the input untouched, even after earlier ops succeeded', () => {
    const draft = wired();
    const before = structuredClone(draft);
    assert.throws(() =>
      applyOps(
        draft,
        [
          { op: 'set_title', title: 'Changed' },
          { op: 'remove_block', blockId: 'blk_t000000001' },
          { op: 'set_view', blockId: 'blk_t000000002', view: 'month' },
        ],
        ctx(),
      ),
    );
    assert.deepEqual(draft, before);
  });

  it('never mutates the input on success either', () => {
    const draft = wired();
    const before = structuredClone(draft);
    applyOps(draft, [{ op: 'remove_block', blockId: 'blk_t000000001' }, add('table')], ctx());
    assert.deepEqual(draft, before);
  });
});

// ─── Patch and inverse (property test) ──────────────────────────────────────

/** mulberry32: a small seeded PRNG, so a failure can be replayed. */
function prng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

function pick<T>(random: () => number, list: readonly T[]): T {
  const value = list[Math.floor(random() * list.length)];
  assert.ok(value !== undefined);
  return value;
}

const WORDS = ['Week', 'Open', 'Due', 'Board', 'Inbox', 'Later'];

/** One plausible op for the draft as it stands. */
function randomOp(random: () => number, draft: DashboardDraft): Op {
  const ids = draft.blocks.map((entry) => entry.id);
  const withQuery = draft.blocks.filter((entry) => entry.query !== undefined).map((e) => e.id);
  const sources = draft.blocks.filter((entry) => entry.type === 'chart' || entry.type === 'filter');
  const calendars = draft.blocks.filter((entry) => entry.type === 'calendar');
  const kind = pick(random, [
    'add_block',
    'add_block',
    'update_block',
    'remove_block',
    'arrange',
    'connect_blocks',
    'apply_template',
    'set_view',
    'set_title',
    'set_vars',
  ]);
  const someId = (): string => pick(random, ids);
  switch (ids.length === 0 ? 'add_block' : kind) {
    case 'update_block':
      return {
        op: 'update_block',
        blockId: someId(),
        patch: random() < 0.5 ? { title: pick(random, WORDS) } : { listen: ['$page.topic'] },
      };
    case 'remove_block':
      return { op: 'remove_block', blockId: someId() };
    case 'arrange':
      return {
        op: 'arrange',
        layouts: {
          [pick(random, BREAKPOINTS)]: [
            {
              i: someId(),
              x: Math.floor(random() * 6),
              y: Math.floor(random() * 30),
              w: 1 + Math.floor(random() * 6),
              h: 1 + Math.floor(random() * 10),
            },
          ],
        },
      };
    case 'connect_blocks': {
      const source = sources[0];
      const targets = withQuery.filter((id) => id !== source?.id);
      if (source === undefined || targets.length === 0) return { op: 'set_title', title: 'Wired' };
      return {
        op: 'connect_blocks',
        fromBlockId: source.id,
        variable: pick(random, ['$page.topic', '$page.provider']),
        toBlockIds: targets
          .filter(() => random() < 0.7)
          .slice(0, 3)
          .concat(targets[0] ?? []),
      };
    }
    case 'apply_template':
      return {
        op: 'apply_template',
        templateKey: 'tpl@1',
        mode: random() < 0.8 ? 'merge' : 'replace',
      };
    case 'set_view': {
      const calendar = calendars[0];
      if (calendar === undefined) return add('calendar');
      return {
        op: 'set_view',
        blockId: calendar.id,
        view: pick(random, ['week', 'month', 'list']),
      };
    }
    case 'set_title':
      return { op: 'set_title', title: pick(random, WORDS) };
    case 'set_vars':
      return {
        op: 'set_vars',
        vars: random() < 0.5 ? { range: 'next_7d' } : { range: 'this_week', topic: 'work' },
      };
    default:
      return add(pick(random, BLOCK_TYPES));
  }
}

describe('patch and inverse (property test, random op sequences of 1–5)', () => {
  it('patch turns before into after; inverse turns after back into before', () => {
    const random = prng(20261112);
    let checked = 0;
    for (let round = 0; round < 250; round += 1) {
      // A random starting dashboard, then a random sequence against it.
      let start = emptyDraft();
      const warmup = Math.floor(random() * 6);
      for (let step = 0; step < warmup; step += 1) {
        try {
          start = applyOps(start, [randomOp(random, start)], ctx()).next;
        } catch {
          // An op that fails validation (say, a 41st block) just doesn't happen.
        }
      }
      // Each op is drawn against the state the sequence so far produces, applied in one call as
      // the final call will apply it (the same ids, since a fresh counter replays the same way).
      const length = 1 + Math.floor(random() * 5);
      const ops: Op[] = [];
      let state = start;
      for (let step = 0; step < length; step += 1) {
        const op = randomOp(random, state);
        try {
          state = applyOps(start, [...ops, op], ctx()).next;
          ops.push(op);
        } catch {
          break;
        }
      }
      if (ops.length === 0) continue;
      const before = structuredClone(start);
      const { next, patch, inverse } = applyOps(start, ops, ctx());
      assert.deepEqual(start, before, 'the input is untouched');

      const forward = structuredClone(before);
      assert.ok(
        applyPatch(forward, patch).every((result) => result === null),
        `round ${String(round)}`,
      );
      assert.deepEqual(forward, next, `round ${String(round)}: patch`);

      const backward = structuredClone(next);
      assert.ok(applyPatch(backward, inverse).every((result) => result === null));
      assert.deepEqual(backward, before, `round ${String(round)}: inverse`);
      checked += 1;
    }
    assert.ok(checked >= 200, `only ${String(checked)} sequences applied`);
  });
});

describe('set_importance (H4)', () => {
  it('stores the page preset on the draft, replaces it, and null returns to the default', () => {
    const fair: Op = { op: 'set_importance', importance: { preset: 'fair', params: {} } };
    const draft = run(emptyDraft(), fair);
    assert.deepEqual(draft.importance, { preset: 'fair', params: {} });
    const weighted = run(draft, {
      op: 'set_importance',
      importance: { preset: 'weighted', params: { weights: { dueSoon: 9 } } },
    });
    assert.deepEqual(weighted.importance, {
      preset: 'weighted',
      params: { weights: { dueSoon: 9 } },
    });
    const cleared = run(weighted, { op: 'set_importance', importance: null });
    assert.equal('importance' in cleared, false);
    assert.equal(summarizeOps([fair]), 'set_importance');
  });

  it('refuses unknown presets, out-of-range weights and bad weight keys', async () => {
    const { OpSchema } = await import('../types/builder.js');
    for (const importance of [
      { preset: 'random', params: {} },
      { preset: 'weighted', params: { weights: { priority: 11 } } },
      { preset: 'weighted', params: { weights: { priority: -1 } } },
      { preset: 'weighted', params: { weights: { 'overlay.attrs.x': 1 } } },
      { preset: 'weighted', params: { weights: { $where: 1 } } },
      { preset: 'fair', params: { weights: {} } },
    ]) {
      assert.equal(OpSchema.safeParse({ op: 'set_importance', importance }).success, false);
    }
    assert.equal(
      OpSchema.safeParse({
        op: 'set_importance',
        importance: { preset: 'weighted', params: { weights: { 'attr.effort': 2, pinned: 0 } } },
      }).success,
      true,
    );
  });
});
