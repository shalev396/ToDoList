/**
 * The timesheet block (a topic's painted time and its open to-dos): its catalog entry and viz
 * schema, the view type that renders it, its check through the Block classes, and its lint. What
 * its query reads is in compile.test.ts and run.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import { Block } from '../classes/dashboard/blocks/index.js';
import {
  BLOCK_TYPES,
  NewBlockSchema,
  VIEW_BLOCK_TYPE,
  VIEW_TYPES,
  VIZ_SCHEMAS,
  type Block as BlockJson,
} from '../types/builder.js';
import { BLOCK_CATALOG, TIMESHEET_TODO_KINDS, describeCatalog } from './catalog.js';
import { compileQuery } from './compile.js';

function timesheet(extra: Partial<BlockJson> = {}): BlockJson {
  return {
    id: 'blk_timesheet',
    type: 'timesheet',
    title: 'Timesheet',
    ...structuredClone(BLOCK_CATALOG.timesheet.defaults),
    ...extra,
  } as BlockJson;
}

describe('timesheet: catalog, schema and view type', () => {
  it('is a block type, a rigid view type rendering it, and in the described catalog', () => {
    assert.ok((BLOCK_TYPES as readonly string[]).includes('timesheet'));
    assert.ok((VIEW_TYPES as readonly string[]).includes('timesheet'));
    assert.equal(VIEW_BLOCK_TYPE.timesheet, 'timesheet');
    const entry = describeCatalog().blockTypes.find((type) => type.type === 'timesheet');
    assert.ok(entry !== undefined);
    assert.deepEqual(entry.allowedViz, ['timesheet']);
    assert.equal(entry.requiredQuery, true);
    assert.deepEqual(entry.size, { w: 12, h: 14 });
    assert.deepEqual(entry.defaults.viz, { kind: 'timesheet', showBlocks: true });
    assert.deepEqual(entry.defaults.listen, ['$page.range', '$page.topic']);
    // The viz schema the editor builds its controls from: one switch.
    assert.deepEqual(Object.keys(entry.vizSchema['properties'] ?? {}), ['kind', 'showBlocks']);
  });

  it('its default query: the page’s topic, its time blocks and areas, its open to-dos', () => {
    const query = BLOCK_CATALOG.timesheet.defaults.query;
    assert.ok(query !== undefined);
    assert.equal(query.dateRange, '$page.range');
    assert.equal(query.limit, 200);
    // Soonest due first, undated last (the panel's order), a plan breaking ties; the compiler puts
    // the timed rows before all of them (compile.test.ts).
    assert.deepEqual(query.sort, [
      { field: 'dueAt', dir: 'asc' },
      { field: 'overlay.plannedAt', dir: 'asc' },
    ]);
    assert.deepEqual(query.where?.rules[0], {
      field: 'topic',
      operator: '=',
      value: '$page.topic',
    });
    assert.deepEqual([...TIMESHEET_TODO_KINDS], ['todo', 'task', 'issue', 'assignment']);
    // It compiles for a timesheet with and without its variables.
    for (const vars of [{}, { topic: 't1', range: 'this_week' }]) {
      assert.doesNotThrow(() =>
        compileQuery(query, {
          ws: { id: 'w' },
          userId: 'u',
          access: { userId: 'u', integrations: [], local: 'visible' },
          vars,
          now: new Date('2026-11-21T10:00:00Z'),
          timeZone: 'Asia/Jerusalem',
          weekStart: 'sun',
          preview: false,
          blockType: 'timesheet',
        }),
      );
    }
  });

  it('the viz schema accepts its options and refuses anything else', () => {
    const schema = VIZ_SCHEMAS.timesheet;
    for (const viz of [
      { kind: 'timesheet' },
      { kind: 'timesheet', showBlocks: true },
      { kind: 'timesheet', showBlocks: false },
    ]) {
      assert.equal(schema.safeParse(viz).success, true, JSON.stringify(viz));
    }
    for (const viz of [
      {},
      { kind: 'calendar' },
      { kind: 'timesheet', showBlocks: 'yes' },
      { kind: 'timesheet', showBlocks: null },
      // The topic is the query's rule, never a viz option.
      { kind: 'timesheet', topic: 't1' },
      { kind: 'timesheet', startHour: 7 },
    ]) {
      assert.equal(schema.safeParse(viz).success, false, JSON.stringify(viz));
    }
    assert.equal(NewBlockSchema.safeParse({ type: 'timesheet' }).success, true);
  });

  it('the block check: the defaults pass; a wrong viz, no query or an unknown field do not', () => {
    assert.deepEqual(Block.from(timesheet()).check(), []);
    assert.deepEqual(Block.from(timesheet({ viz: { kind: 'timesheet' } })).check(), []);
    assert.deepEqual(
      Block.from(timesheet({ viz: { kind: 'calendar' } }))
        .check()
        .map((issue) => issue.pointer),
      ['/viz/kind'],
    );
    assert.deepEqual(
      Block.from(timesheet({ viz: { kind: 'timesheet', showBlocks: 1 } }))
        .check()
        .map((issue) => issue.pointer),
      ['/viz/showBlocks'],
    );
    assert.deepEqual(Block.from(timesheet({ query: undefined })).check(), [
      { pointer: '/query', message: 'a timesheet block needs a query or a saved view' },
    ]);
    assert.deepEqual(Block.from(timesheet({ query: undefined, savedViewId: 'v1' })).check(), []);
    const unknown = Block.from(
      timesheet({
        query: {
          source: 'items',
          where: { combinator: 'and', rules: [{ field: 'nope', operator: '=', value: 1 }] },
        },
      }),
    ).check();
    assert.deepEqual(
      unknown.map((issue) => issue.pointer),
      ['/query/where/rules/0/field'],
    );
  });
});

describe('timesheet: lint', () => {
  it('its defaults are clean in both modes', () => {
    for (const mode of ['ui', 'mcp'] as const) {
      assert.deepEqual(Block.from(timesheet()).lint({ mode, topicIds: new Set(['t1']) }), []);
    }
  });

  it('every row links to its source: turning that off is an error', () => {
    const issues = Block.from(timesheet({ viz: { kind: 'timesheet', showSource: false } })).lint({
      mode: 'ui',
    });
    assert.deepEqual(
      issues.map((issue) => [issue.code, issue.severity, issue.pointer]),
      [['source_link_hidden', 'error', '/viz/showSource']],
    );
  });

  it('free text in its viz is hard-coded text: a warning in the UI, an error for agents', () => {
    const block = Block.from(timesheet({ viz: { kind: 'timesheet', caption: 'My week' } }));
    assert.deepEqual(
      block.lint({ mode: 'ui' }).map((issue) => [issue.code, issue.severity]),
      [['hardcoded_text', 'warning']],
    );
    assert.deepEqual(
      block.lint({ mode: 'mcp' }).map((issue) => [issue.code, issue.severity]),
      [['hardcoded_text', 'error']],
    );
  });

  it('a topic picked by id that the workspace no longer has is a deleted page', () => {
    const query = structuredClone(BLOCK_CATALOG.timesheet.defaults.query);
    assert.ok(query?.where !== undefined);
    query.where.rules[0] = { field: 'topic', operator: '=', value: 'gone' };
    const issues = Block.from(timesheet({ query })).lint({
      mode: 'mcp',
      topicIds: new Set(['t1']),
    });
    assert.deepEqual(
      issues.map((issue) => [issue.code, issue.severity, issue.pointer]),
      [['deleted_topic', 'warning', '/query/where/rules/0/value']],
    );
  });
});
