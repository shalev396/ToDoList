import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { Ajv2020 } from 'ajv/dist/2020.js';
import { z } from 'zod';

import { BLOCK_CATALOG, describeCatalog } from '../builder/catalog.js';
import { Block as BlockClass } from '../classes/dashboard/blocks/index.js';
import {
  BLOCK_TYPES,
  BlockSchema,
  CAPS,
  DashboardDraftSchema,
  DashboardScopeSchema,
  DateRangeSchema,
  NewBlockSchema,
  OpSchema,
  QueryRequestSchema,
  QuerySchema,
  RuleGroupSchema,
  VIZ_SCHEMAS,
  type Block,
  type BlockType,
  type Rule,
} from './builder.js';

function rules(count: number): Rule[] {
  return Array.from({ length: count }, (_, index) => ({
    field: 'priority',
    operator: '>=',
    value: index,
  }));
}

function defaultBlock(type: BlockType, id = `blk_${type.toLowerCase()}_1`): Block {
  return { id, type, title: 'Block', ...BLOCK_CATALOG[type].defaults } as Block;
}

function dashboard(blocks: Block[], lg: { i: string }[] = []): Record<string, unknown> {
  return {
    title: 'Dashboard',
    scope: { topicId: null, containerId: null, page: 'topic' },
    vars: { range: 'this_week', course: null },
    layouts: { lg: lg.map(({ i }, y) => ({ i, x: 0, y, w: 6, h: 4 })), md: [], sm: [] },
    blocks,
  };
}

/** The modules a file under types/ imports, as written in its import lines. */
function importsOf(file: string): (string | undefined)[] {
  const source = readFileSync(new URL(file, import.meta.url), 'utf8');
  return [...source.matchAll(/^import[^'"]*['"]([^'"]+)['"]/gm)].map((match) => match[1]);
}

describe('types/builder.ts', () => {
  it('imports only zod, ./domain.js, ./importance.js and ./limits.js, so the client can use it as is', () => {
    assert.deepEqual(importsOf('./builder.ts').sort(), [
      './domain.js',
      './importance.js',
      './limits.js',
      'zod',
    ]);
    // The plan's limits (CAPS.maxBlocks reads them) are plain numbers with no imports of their own.
    assert.deepEqual(importsOf('./limits.ts'), []);
  });
});

describe('block catalog defaults', () => {
  it('covers every block type', () => {
    assert.deepEqual(Object.keys(BLOCK_CATALOG).sort(), [...BLOCK_TYPES].sort());
  });

  for (const type of BLOCK_TYPES) {
    it(`the ${type} defaults validate against the block schema and the catalog`, () => {
      const block = defaultBlock(type);
      const parsed = BlockSchema.safeParse(block);
      assert.ok(parsed.success, JSON.stringify(parsed.error?.issues));
      assert.deepEqual(BlockClass.from(parsed.data).check(), []);
      assert.ok(BLOCK_CATALOG[type].allowedViz.includes(String(block.viz['kind'])));
      assert.equal(block.query !== undefined, BLOCK_CATALOG[type].requiredQuery);
    });
  }

  it('calendar viz takes a startHour from 0 to 23', () => {
    const parse = (startHour: number): boolean =>
      VIZ_SCHEMAS.calendar.safeParse({ kind: 'calendar', startHour }).success;
    assert.equal(parse(0), true);
    assert.equal(parse(23), true);
    assert.equal(parse(24), false);
    assert.equal(parse(-1), false);
    assert.equal(parse(7.5), false);
  });

  it('matches BUILDER §4: donut by provider, week calendar, deadlines up to 14 days out', () => {
    const chart = BLOCK_CATALOG.chart.defaults;
    assert.deepEqual(chart.query?.groupBy, ['source.provider']);
    assert.deepEqual(chart.query.aggregate, { op: 'count' });
    assert.equal(chart.viz?.['kind'], 'donut');
    assert.equal(BLOCK_CATALOG.calendar.defaults.viz?.['view'], 'week');
    // Calendars show due-only items too; deadlines include overdue items (sorted on top).
    assert.equal(BLOCK_CATALOG.calendar.defaults.query?.dateField, 'any');
    const deadlines = BLOCK_CATALOG.deadlines.defaults.query;
    assert.equal(deadlines?.dateRange, 'upcoming_14d');
    assert.deepEqual(deadlines.sort, [{ field: 'dueAt', dir: 'asc' }]);
    assert.deepEqual(BLOCK_CATALOG.kanban.defaults.query?.groupBy, ['status']);
    assert.equal(BLOCK_CATALOG.note.defaults.query, undefined);
  });

  it('gives every type a default size that fits the 12-column grid', () => {
    for (const type of BLOCK_TYPES) {
      const { w, h } = BLOCK_CATALOG[type].size;
      assert.ok(Number.isInteger(w) && w >= 1 && w <= 12, `${type} width`);
      assert.ok(Number.isInteger(h) && h >= 1, `${type} height`);
    }
    assert.deepEqual(
      describeCatalog().blockTypes.find((entry) => entry.type === 'calendar')?.size,
      {
        w: 8,
        h: 10,
      },
    );
  });

  it('a list may link its rows to their group page (a course list opens the course)', () => {
    assert.ok(VIZ_SCHEMAS.list.safeParse({ kind: 'list', linkTo: 'group' }).success);
    assert.equal(VIZ_SCHEMAS.list.safeParse({ kind: 'list', linkTo: 'elsewhere' }).success, false);
  });

  it('a block’s check reports a missing query, a wrong viz kind and a filter without sets', () => {
    const table = defaultBlock('table');
    delete table.query;
    assert.deepEqual(
      BlockClass.from(table)
        .check()
        .map((issue) => issue.pointer),
      ['/query'],
    );
    const viaSavedView: Block = { ...table, savedViewId: 'v-1' };
    assert.deepEqual(BlockClass.from(viaSavedView).check(), []);
    const wrongViz: Block = { ...defaultBlock('chart'), viz: { kind: 'calendar', view: 'week' } };
    assert.equal(BlockClass.from(wrongViz).check()[0]?.pointer, '/viz/kind');
    const filter = defaultBlock('filter');
    delete filter.sets;
    assert.deepEqual(
      BlockClass.from(filter)
        .check()
        .map((issue) => issue.pointer),
      ['/sets'],
    );
  });
});

describe('JSON Schema export (z.toJSONSchema → Ajv 2020-12)', () => {
  // Zod emits `format: date-time` next to its own pattern; the pattern does the checking.
  const ajv = new Ajv2020({ strict: true, allErrors: true, formats: { 'date-time': true } });

  const schemas: Record<string, z.ZodType> = {
    query: QuerySchema,
    ruleGroup: RuleGroupSchema,
    block: BlockSchema,
    newBlock: NewBlockSchema,
    dashboard: DashboardDraftSchema,
    op: OpSchema,
    queryRequest: QueryRequestSchema,
    ...Object.fromEntries(
      Object.entries(VIZ_SCHEMAS).map(([type, schema]) => [`viz.${type}`, schema]),
    ),
  };

  for (const [name, schema] of Object.entries(schemas)) {
    it(`${name} compiles`, () => {
      const jsonSchema = z.toJSONSchema(schema, { target: 'draft-2020-12' });
      assert.equal(jsonSchema.$schema, 'https://json-schema.org/draft/2020-12/schema');
      ajv.compile(jsonSchema);
    });
  }

  it('the compiled block and dashboard schemas accept the catalog defaults', () => {
    const validateBlock = ajv.compile(z.toJSONSchema(BlockSchema, { target: 'draft-2020-12' }));
    const validateDashboard = ajv.compile(
      z.toJSONSchema(DashboardDraftSchema, { target: 'draft-2020-12' }),
    );
    const blocks = BLOCK_TYPES.map((type) => defaultBlock(type));
    for (const block of blocks) {
      assert.ok(validateBlock(block), JSON.stringify(validateBlock.errors));
    }
    const draft = dashboard(
      blocks,
      blocks.map(({ id }) => ({ i: id })),
    );
    assert.ok(validateDashboard(draft), JSON.stringify(validateDashboard.errors));
  });

  it('describeCatalog() serves block types, fields with operators, presets, caps and schemas', () => {
    const catalog = describeCatalog();
    assert.deepEqual(
      catalog.blockTypes.map((entry) => entry.type),
      [...BLOCK_TYPES],
    );
    assert.deepEqual(catalog.caps, CAPS);
    assert.ok(catalog.datePresets.includes('this_semester'));
    const status = catalog.fields.items.find((field) => field.field === 'status');
    assert.deepEqual(status?.operators, ['=', '!=', 'in', 'notIn', 'null', 'notNull']);
    assert.deepEqual(status.values, ['open', 'in_progress', 'done', 'cancelled']);
    assert.equal(catalog.fields.containers.find((field) => field.field === 'type')?.type, 'enum');
    for (const schema of Object.values(catalog.schemas)) ajv.compile(schema);
    for (const entry of catalog.blockTypes) ajv.compile(entry.vizSchema);
    // Plain JSON: it is served as is by the catalog route and MCP.
    assert.deepEqual(JSON.parse(JSON.stringify(catalog)), catalog);
  });

  it('never lists a credential, token or secret path as a field', () => {
    const catalog = describeCatalog();
    const fields = [...catalog.fields.items, ...catalog.fields.containers].map((f) => f.field);
    for (const field of fields) {
      assert.doesNotMatch(field, /credential|token|secret|password|enc\b|apikey/i);
    }
  });
});

describe('caps', () => {
  const where = (list: unknown[]): unknown => ({ combinator: 'and', rules: list });

  it('accepts 10 rules', () => {
    assert.ok(QuerySchema.safeParse({ source: 'items', where: where(rules(10)) }).success);
  });

  it('rejects 11 flat rules', () => {
    const result = QuerySchema.safeParse({ source: 'items', where: where(rules(11)) });
    assert.equal(result.success, false);
  });

  it('rejects 11 rules spread over nested groups', () => {
    const nested = where([
      ...rules(4),
      { combinator: 'or', rules: [...rules(4), { combinator: 'and', rules: rules(3) }] },
    ]);
    assert.equal(QuerySchema.safeParse({ source: 'items', where: nested }).success, false);
    const ten = where([...rules(4), { combinator: 'or', rules: rules(6) }]);
    assert.ok(QuerySchema.safeParse({ source: 'items', where: ten }).success);
  });

  it('rejects groups nested too deep', () => {
    let group: unknown = { combinator: 'and', rules: rules(1) };
    for (let depth = 0; depth < 6; depth += 1) group = { combinator: 'and', rules: [group] };
    assert.equal(RuleGroupSchema.safeParse(group).success, false);
  });

  it('rejects 4 group-bys', () => {
    const groupBy = ['status', 'topic', 'kind', 'priority'];
    assert.equal(QuerySchema.safeParse({ source: 'items', groupBy }).success, false);
    assert.ok(QuerySchema.safeParse({ source: 'items', groupBy: groupBy.slice(0, 3) }).success);
  });

  it('rejects a field listed twice in groupBy or sort, and a 4th sort', () => {
    assert.equal(
      QuerySchema.safeParse({ source: 'items', groupBy: ['topic', 'topic'] }).success,
      false,
    );
    const sort = (fields: string[]): unknown => ({
      source: 'items',
      sort: fields.map((field) => ({ field, dir: 'asc' })),
    });
    assert.equal(QuerySchema.safeParse(sort(['dueAt', 'dueAt'])).success, false);
    assert.equal(
      QuerySchema.safeParse(sort(['dueAt', 'title', 'priority', 'kind'])).success,
      false,
    );
    assert.ok(QuerySchema.safeParse(sort(['dueAt', 'title', 'priority'])).success);
  });

  it('rejects a limit above 200', () => {
    assert.equal(QuerySchema.safeParse({ source: 'items', limit: 201 }).success, false);
    assert.equal(QuerySchema.safeParse({ source: 'items', limit: 0 }).success, false);
  });

  it('rejects 41 blocks', () => {
    const blocks = Array.from({ length: 41 }, (_, index) =>
      defaultBlock('list', `blk_list_${String(index).padStart(2, '0')}`),
    );
    assert.equal(DashboardDraftSchema.safeParse(dashboard(blocks)).success, false);
    assert.ok(DashboardDraftSchema.safeParse(dashboard(blocks.slice(0, 40))).success);
  });
});

describe('dashboard draft', () => {
  it('accepts layouts that point at its blocks', () => {
    const blocks = [defaultBlock('clock'), defaultBlock('chart')];
    const result = DashboardDraftSchema.safeParse(dashboard(blocks, [{ i: 'blk_clock_1' }]));
    assert.ok(result.success, JSON.stringify(result.error?.issues));
  });

  it('rejects a layout item pointing at a missing block', () => {
    const result = DashboardDraftSchema.safeParse(
      dashboard([defaultBlock('clock')], [{ i: 'blk_missing' }]),
    );
    assert.equal(result.success, false);
    assert.deepEqual(result.error.issues[0]?.path, ['layouts', 'lg', 0, 'i']);
  });

  it('rejects duplicate block ids', () => {
    const result = DashboardDraftSchema.safeParse(
      dashboard([defaultBlock('clock', 'blk_same'), defaultBlock('chart', 'blk_same')]),
    );
    assert.equal(result.success, false);
    assert.deepEqual(result.error.issues[0]?.path, ['blocks', 1, 'id']);
  });

  it('rejects block ids outside ^blk_[a-z0-9_]{3,40}$ and unknown keys', () => {
    assert.equal(BlockSchema.safeParse(defaultBlock('clock', 'blk_x')).success, false);
    assert.equal(BlockSchema.safeParse(defaultBlock('clock', 'clock_1')).success, false);
    assert.equal(BlockSchema.safeParse({ ...defaultBlock('clock'), extra: 1 }).success, false);
  });

  it('keeps note text on note blocks and `sets` on filter blocks', () => {
    assert.equal(BlockSchema.safeParse({ ...defaultBlock('list'), note: 'hi' }).success, false);
    assert.equal(
      BlockSchema.safeParse({ ...defaultBlock('list'), sets: '$page.topic' }).success,
      false,
    );
    assert.equal(
      BlockSchema.safeParse({ ...defaultBlock('note'), note: 'x'.repeat(5001) }).success,
      false,
    );
  });
});

describe('value forms', () => {
  it('a date range is a preset, a $page variable or {from, to}', () => {
    assert.ok(DateRangeSchema.safeParse('this_semester').success);
    assert.ok(DateRangeSchema.safeParse('$page.range').success);
    assert.ok(
      DateRangeSchema.safeParse({ from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00+02:00' })
        .success,
    );
    assert.equal(DateRangeSchema.safeParse('next_week').success, false);
    assert.equal(DateRangeSchema.safeParse('$page.2bad').success, false);
    assert.equal(DateRangeSchema.safeParse({ from: '2026-11-08T00:00:00Z' }).success, false);
    assert.equal(
      DateRangeSchema.safeParse({ from: '2026-11-08T00:00:00Z', to: '2026-11-01T00:00:00Z' })
        .success,
      false,
    );
  });

  it('containerType is only for container queries, dateRange only for items', () => {
    assert.ok(QuerySchema.safeParse({ source: 'containers', containerType: 'course' }).success);
    assert.equal(
      QuerySchema.safeParse({ source: 'items', containerType: 'course' }).success,
      false,
    );
    assert.equal(
      QuerySchema.safeParse({ source: 'containers', dateRange: 'today' }).success,
      false,
    );
  });

  it('a display rule sets a tone, hides, or shows a badge of at most 20 characters', () => {
    const rule = { field: 'dueAt', operator: '<', value: '@now' };
    const block = (then: unknown): unknown => ({
      ...defaultBlock('list'),
      rules: [{ if: rule, then }],
    });
    assert.ok(BlockSchema.safeParse(block({ tone: 'destructive' })).success);
    assert.ok(BlockSchema.safeParse(block({ hide: true })).success);
    assert.ok(BlockSchema.safeParse(block({ badge: 'late' })).success);
    assert.equal(BlockSchema.safeParse(block({ badge: 'x'.repeat(21) })).success, false);
    assert.equal(BlockSchema.safeParse(block({ tone: 'loud' })).success, false);
  });
});

describe('ops', () => {
  it('add_block takes a block without an id; catalog defaults fill the rest', () => {
    const op = {
      op: 'add_block',
      block: {
        type: 'deadlines',
        title: 'Deadlines',
        query: { source: 'items', dateRange: 'next_14d' },
      },
      layout: { lg: { x: 0, y: 20, w: 12, h: 6 } },
    };
    assert.ok(OpSchema.safeParse(op).success);
    assert.equal(
      OpSchema.safeParse({ ...op, block: { ...op.block, id: 'blk_deadlines' } }).success,
      false,
    );
    assert.equal(
      OpSchema.safeParse({ ...op, layout: { lg: { x: 0, y: 0, w: 0, h: 6 } } }).success,
      false,
    );
  });

  it('validates every named op', () => {
    const valid: unknown[] = [
      { op: 'update_block', blockId: 'blk_cal', patch: { title: 'Week' } },
      { op: 'remove_block', blockId: 'blk_cal' },
      { op: 'arrange', layouts: { sm: [{ i: 'blk_cal', x: 0, y: 0, w: 1, h: 4 }] } },
      {
        op: 'connect_blocks',
        fromBlockId: 'blk_donut',
        variable: '$page.provider',
        field: 'source.provider',
        toBlockIds: ['blk_cal'],
      },
      { op: 'apply_template', templateKey: 'college@1', mode: 'merge' },
      { op: 'set_view', blockId: 'blk_cal', view: 'month' },
      { op: 'set_title', title: 'College' },
      { op: 'set_vars', vars: { range: 'this_week', course: null } },
    ];
    for (const op of valid) assert.ok(OpSchema.safeParse(op).success, JSON.stringify(op));

    const invalid: unknown[] = [
      { op: 'update_block', blockId: 'blk_cal', patch: { type: 'chart' } },
      { op: 'update_block', blockId: 'blk_cal', patch: {} },
      { op: 'connect_blocks', fromBlockId: 'blk_donut', variable: '$page.p', toBlockIds: [] },
      { op: 'apply_template', templateKey: 'college@1', mode: 'overwrite' },
      { op: 'set_view', blockId: 'blk_cal', view: 'year' },
      { op: 'set_title', title: '' },
      { op: 'drop_database' },
    ];
    for (const op of invalid)
      assert.equal(OpSchema.safeParse(op).success, false, JSON.stringify(op));
  });
});

describe('query request', () => {
  it('takes exactly one of savedQueryId, dashboardId + blockId, or draft', () => {
    const ok: unknown[] = [
      { savedQueryId: 'v-1' },
      { dashboardId: 'd-1', blockId: 'blk_cal', vars: { '$page.topic': 'work' }, preview: true },
      { draft: { source: 'items' }, vars: { range: 'today' } },
    ];
    for (const body of ok)
      assert.ok(QueryRequestSchema.safeParse(body).success, JSON.stringify(body));
    const bad: unknown[] = [
      {},
      { savedQueryId: 'v-1', draft: { source: 'items' } },
      { dashboardId: 'd-1' },
      { blockId: 'blk_cal' },
      { draft: { source: 'items' }, vars: { $where: 'x' } },
      { draft: { source: 'items' }, vars: { topic: { $ne: null } } },
    ];
    for (const body of bad) {
      assert.equal(QueryRequestSchema.safeParse(body).success, false, JSON.stringify(body));
    }
  });

  it('a draft may name its block type (for the default dateField); nothing else may', () => {
    const ok = QueryRequestSchema.safeParse({ draft: { source: 'items' }, blockType: 'calendar' });
    assert.ok(ok.success);
    assert.equal(ok.data.blockType, 'calendar');
    const bad: unknown[] = [
      { draft: { source: 'items' }, blockType: 'gauge' },
      { savedQueryId: 'v-1', blockType: 'calendar' },
      { dashboardId: 'd-1', blockId: 'blk_cal', blockType: 'calendar' },
    ];
    for (const body of bad) {
      assert.equal(QueryRequestSchema.safeParse(body).success, false, JSON.stringify(body));
    }
  });
});

describe('dashboard scope', () => {
  it('a group page names the variable its route sets; a topic page has none', () => {
    const ok: unknown[] = [
      { topicId: null, containerId: null, page: 'topic' },
      { topicId: 'topic-work', containerId: null, page: 'topic', groupVar: null },
      { topicId: 'topic-college', containerId: null, page: 'group', groupVar: 'course' },
    ];
    for (const scope of ok) {
      assert.ok(DashboardScopeSchema.safeParse(scope).success, JSON.stringify(scope));
    }
    const bad: [unknown, string][] = [
      [{ topicId: 'topic-college', containerId: null, page: 'group' }, 'groupVar'],
      [{ topicId: 'topic-college', containerId: null, page: 'group', groupVar: null }, 'groupVar'],
      [
        { topicId: 'topic-work', containerId: null, page: 'topic', groupVar: 'project' },
        'groupVar',
      ],
      [
        { topicId: 'topic-work', containerId: null, page: 'group', groupVar: '$page.project' },
        'groupVar',
      ],
    ];
    for (const [scope, key] of bad) {
      const result = DashboardScopeSchema.safeParse(scope);
      assert.equal(result.success, false, JSON.stringify(scope));
      assert.deepEqual(result.error.issues[0]?.path, [key]);
    }
  });
});

describe('dates on queries', () => {
  it('dateField takes dueAt, startAt or any; any is for items only', () => {
    for (const dateField of ['dueAt', 'startAt', 'any']) {
      assert.ok(QuerySchema.safeParse({ source: 'items', dateField }).success, dateField);
    }
    assert.equal(QuerySchema.safeParse({ source: 'items', dateField: 'endAt' }).success, false);
    assert.equal(QuerySchema.safeParse({ source: 'containers', dateField: 'any' }).success, false);
  });

  it('dateRange takes the upcoming presets', () => {
    for (const preset of ['upcoming_7d', 'upcoming_14d']) {
      assert.ok(DateRangeSchema.safeParse(preset).success, preset);
    }
  });
});
