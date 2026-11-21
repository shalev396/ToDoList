/**
 * The Block hierarchy: the registry (one class per catalog type, an unknown type's fallback), the
 * capability contracts each class declares and implements (as the integration capability test
 * does), immutability and `toJSON`, the contracts' answers, and the order of the template methods.
 * What the classes answer for whole documents is pinned by docCheck.golden.test.ts.
 */
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';

import { BLOCK_CATALOG } from '../../../builder/catalog.js';
import { BLOCK_TYPES, type BlockType, type Block as BlockJson } from '../../../types/builder.js';
import { Query } from '../Query.js';
import {
  ActionBlock,
  AgendaBlock,
  Block,
  BlockRegistry,
  CalendarBlock,
  ChartBlock,
  ClockBlock,
  CounterBlock,
  DeadlinesBlock,
  FilterBlock,
  isControlBlock,
  isDataBlock,
  isTimeBlock,
  KanbanBlock,
  ListBlock,
  NoteBlock,
  QueryBlock,
  RowBlock,
  TableBlock,
  TimelineBlock,
  TimesheetBlock,
  UnknownBlock,
  WorkloadBlock,
  type BlockCapability,
} from './index.js';

/** A block of `type` with the catalog's defaults, as the builder's tests make one. */
function jsonOf(type: BlockType, extra: Record<string, unknown> = {}): BlockJson {
  return {
    id: `blk_${type}_1`,
    type,
    title: 'Any title',
    ...structuredClone(BLOCK_CATALOG[type].defaults),
    ...extra,
  } as BlockJson;
}

const UNKNOWN_FIELD_QUERY = {
  source: 'items',
  where: { combinator: 'and', rules: [{ field: 'nope.field', operator: '=', value: 1 }] },
};

const CLASSES: Readonly<Record<BlockType, unknown>> = {
  list: ListBlock,
  table: TableBlock,
  kanban: KanbanBlock,
  calendar: CalendarBlock,
  chart: ChartBlock,
  clock: ClockBlock,
  counter: CounterBlock,
  deadlines: DeadlinesBlock,
  note: NoteBlock,
  filter: FilterBlock,
  action: ActionBlock,
  timeline: TimelineBlock,
  agenda: AgendaBlock,
  workload: WorkloadBlock,
  timesheet: TimesheetBlock,
};

describe('BlockRegistry and Block.from', () => {
  it('has one class per catalog type, and Block.from makes it, frozen', () => {
    assert.deepEqual(BlockRegistry.instance.types(), [...BLOCK_TYPES].sort());
    for (const type of BLOCK_TYPES) {
      const block = Block.from(jsonOf(type));
      assert.equal(block.constructor, CLASSES[type], type);
      assert.equal(BlockRegistry.instance.classOf(type), CLASSES[type], type);
      assert.equal(block.type, type);
      assert.ok(block instanceof Block);
      assert.ok(Object.isFrozen(block), type);
    }
  });

  it('refuses any second registration: another class, the same class, a second fallback (M4)', () => {
    // A subclass whose factory would stand in for the list's: no catalog rule, no compile check.
    class LaxList extends ListBlock {
      override check(): [] {
        return [];
      }

      static make(json: BlockJson): LaxList {
        return new LaxList(json);
      }
    }
    for (const register of [
      (): void => {
        BlockRegistry.instance.register('list', TableBlock, (json) => Block.from(json));
      },
      (): void => {
        BlockRegistry.instance.register('list', ListBlock, (json) => LaxList.make(json));
      },
    ]) {
      assert.throws(register, { message: 'A block class for "list" is already registered' });
    }
    assert.throws(
      () => {
        BlockRegistry.instance.registerFallback((json) => LaxList.make(json));
      },
      { message: 'The fallback block class is already registered' },
    );
    assert.equal(Block.from(jsonOf('list')).constructor, ListBlock);
  });

  it('is sealed once every class is in: nothing registers after it', () => {
    assert.equal(BlockRegistry.instance.isSealed, true);
    assert.throws(
      () => {
        BlockRegistry.instance.register('brand-new' as BlockType, ListBlock, (json) =>
          Block.from(json),
        );
      },
      {
        message: 'The block registry is sealed: a block class for "brand-new" cannot register now',
      },
    );
    // Sealing again checks again, and changes nothing.
    BlockRegistry.instance.seal();
    assert.deepEqual(BlockRegistry.instance.types(), [...BLOCK_TYPES].sort());
  });

  it('an unknown type gets UnknownBlock, with the issue the document schema reports', () => {
    const block = Block.from({ ...jsonOf('note'), type: 'no-such-type' as BlockType });
    assert.ok(block instanceof UnknownBlock);
    assert.equal(block.type, 'no-such-type');
    // Today's refusal of the same block inside a document (docCheck.golden.json).
    const golden = JSON.parse(
      readFileSync(new URL('../docCheck.golden.json', import.meta.url), 'utf8'),
    ) as { checks: Record<string, { issues: { pointer: string; message: string }[] }> };
    const schemaIssue = golden.checks['schema issues, several']?.issues.find(
      (found) => found.pointer === '/blocks/0/type',
    );
    assert.ok(schemaIssue !== undefined);
    assert.deepEqual(block.check(), [{ pointer: '/type', message: schemaIssue.message }]);
    assert.deepEqual(
      Block.from({
        ...jsonOf('list'),
        type: 'gone' as BlockType,
        query: UNKNOWN_FIELD_QUERY,
      } as BlockJson).check(),
      [{ pointer: '/type', message: schemaIssue.message }],
    );
  });

  it('the template steps are the base’s own: only the hooks, and the Null Object’s whole check, are overridable', () => {
    for (const step of ['catalogIssues', 'queryIssues']) {
      assert.equal(step in Block.prototype, false, step);
    }
    for (const hook of ['checkSpecific', 'lintSpecific']) {
      assert.equal(
        typeof (Block.prototype as unknown as Record<string, unknown>)[hook],
        'function',
      );
    }
    assert.equal(Object.hasOwn(UnknownBlock.prototype, 'check'), true);
    for (const cls of Object.values(CLASSES)) {
      assert.equal(Object.hasOwn((cls as typeof Block).prototype, 'check'), false);
    }
  });
});

describe('capability contracts', () => {
  const declared = (type: BlockType): BlockCapability[] =>
    [...BlockRegistry.instance.classOf(type).capabilities].sort();
  const implemented = (type: BlockType): BlockCapability[] => {
    const block = Block.from(jsonOf(type));
    const found: BlockCapability[] = [];
    if (isControlBlock(block)) found.push('control');
    if (isDataBlock(block)) found.push('data');
    if (isTimeBlock(block)) found.push('time');
    return found;
  };

  it('each class implements what it declares, and nothing else', () => {
    // [DataBlock, TimeBlock, ControlBlock]
    const row = (type: BlockType): boolean[] =>
      (['data', 'time', 'control'] as const).map((capability) =>
        implemented(type).includes(capability),
      );
    for (const type of ['list', 'table', 'kanban', 'chart', 'counter'] as const) {
      assert.deepEqual(row(type), [true, false, false], type);
    }
    for (const type of ['deadlines', 'timeline', 'agenda', 'workload'] as const) {
      assert.deepEqual(row(type), [true, false, false], type);
    }
    assert.deepEqual(row('calendar'), [true, true, false]);
    // The timesheet draws the visible week, as the calendar does.
    assert.deepEqual(row('timesheet'), [true, true, false]);
    // The clock reads a query (the catalog requires one): a data block too, unlike the plan's table.
    assert.deepEqual(row('clock'), [true, true, false]);
    assert.deepEqual(row('filter'), [false, false, true]);
    assert.deepEqual(row('action'), [false, false, true]);
    assert.deepEqual(row('note'), [false, false, false]);
    for (const type of BLOCK_TYPES) assert.deepEqual(declared(type), implemented(type), type);
  });

  it('a data block is exactly a type whose catalog entry requires a query', () => {
    for (const type of BLOCK_TYPES) {
      const block = Block.from(jsonOf(type));
      assert.equal(isDataBlock(block), BLOCK_CATALOG[type].requiredQuery, type);
      assert.equal(block instanceof QueryBlock, BLOCK_CATALOG[type].requiredQuery, type);
    }
  });

  it('the row blocks (the source-link lint) are the ones that rendered rows before', () => {
    const rows = BLOCK_TYPES.filter((type) => Block.from(jsonOf(type)) instanceof RowBlock);
    assert.deepEqual(
      [...rows].sort(),
      [
        'agenda',
        'calendar',
        'deadlines',
        'kanban',
        'list',
        'table',
        'timeline',
        'timesheet',
      ].sort(),
    );
  });
});

describe('a block as a value object', () => {
  it('toJSON is exactly the JSON it was made from, as a copy', () => {
    for (const type of BLOCK_TYPES) {
      const json = jsonOf(type, { sourceRemoved: true, connectors: ['local'] });
      const block = Block.from(json);
      assert.deepEqual(block.toJSON(), json, type);
      assert.equal(JSON.stringify(block.toJSON()), JSON.stringify(json), type);
      assert.notEqual(block.toJSON(), block.toJSON());
    }
    // A key set to undefined stays, as the parsed draft has it.
    const keyed = jsonOf('counter', { query: undefined });
    assert.deepEqual(Object.keys(Block.from(keyed).toJSON()), Object.keys(keyed));
  });

  it('nothing changes it: not the JSON it came from, not its copies, not its fields', () => {
    const json = jsonOf('list');
    const block = Block.from(json);
    json.title = 'Changed';
    json.viz['kind'] = 'table';
    const copy = block.toJSON();
    copy.title = 'Changed too';
    assert.equal(block.title, 'Any title');
    assert.equal(block.toJSON().viz['kind'], 'list');
    assert.throws(() => {
      (block as unknown as { type: string }).type = 'table';
    }, TypeError);
    assert.equal(block.id, 'blk_list_1');
  });
});

describe('the contracts', () => {
  it('DataBlock: the embedded query as a Query, or the saved view instead', () => {
    const list = Block.from(jsonOf('list'));
    assert.ok(isDataBlock(list));
    assert.equal(list.query()?.equals(Query.from({ source: 'items', limit: 50 })), true);
    assert.equal(list.savedViewId, null);
    const saved = Block.from(jsonOf('chart', { query: undefined, savedViewId: 'view-1' }));
    assert.ok(isDataBlock(saved));
    assert.equal(saved.query(), null);
    assert.equal(saved.savedViewId, 'view-1');
    // A query stored as null (the schema refuses it) is no query, never a Query wrapping null.
    const nulled = Block.from(jsonOf('counter', { query: null }));
    assert.ok(isDataBlock(nulled));
    assert.equal(nulled.query(), null);
    assert.equal(nulled.toJSON().query, null, 'the JSON stays as given');
  });

  it('TimeBlock: the span it draws', () => {
    const calendar = Block.from(jsonOf('calendar'));
    const clock = Block.from(jsonOf('clock'));
    assert.ok(isTimeBlock(calendar) && isTimeBlock(clock));
    assert.equal(calendar.range, '$page.range');
    assert.equal(clock.range, 'today');
    const timesheet = Block.from(jsonOf('timesheet'));
    assert.ok(isTimeBlock(timesheet));
    assert.equal(timesheet.range, '$page.range');
    const viewed = Block.from(jsonOf('calendar', { query: undefined, savedViewId: 'view-1' }));
    assert.ok(isTimeBlock(viewed));
    assert.equal(viewed.range, null);
  });

  it('ControlBlock: the variable a filter sets, the action a button runs', () => {
    const filter = Block.from(jsonOf('filter'));
    const action = Block.from(jsonOf('action'));
    assert.ok(isControlBlock(filter) && isControlBlock(action));
    assert.deepEqual(filter.controls(), { sets: '$page.topic' });
    assert.deepEqual(action.controls(), { runs: 'sync_gcal' });
    const idle = Block.from(jsonOf('filter', { sets: undefined }));
    assert.ok(isControlBlock(idle));
    assert.equal(idle.controls(), null);
  });
});

describe('the template methods', () => {
  it('check: the catalog entry, then the type’s own rules, then the query', () => {
    const filter = Block.from(
      jsonOf('filter', { viz: { kind: 'tabs' }, sets: undefined, query: UNKNOWN_FIELD_QUERY }),
    );
    assert.deepEqual(
      filter.check().map((found) => found.pointer),
      ['/viz/kind', '/query', '/sets', '/query/where/rules/0/field'],
    );
    const action = Block.from(jsonOf('action', { action: undefined }));
    assert.deepEqual(action.check(), [
      { pointer: '/action', message: 'an action block names its action' },
    ]);
    const list = Block.from(jsonOf('list', { query: undefined }));
    assert.deepEqual(list.check(), [
      { pointer: '/query', message: 'a list block needs a query or a saved view' },
    ]);
    for (const type of BLOCK_TYPES) assert.deepEqual(Block.from(jsonOf(type)).check(), [], type);
  });

  it('lint: the fields, then the source link of a row block, then the text', () => {
    const viz = { kind: 'list', showSource: false, caption: 'Hello' };
    const list = Block.from(
      jsonOf('list', {
        viz,
        query: {
          source: 'items',
          where: { combinator: 'and', rules: [{ field: 'props.apiKey', operator: 'notNull' }] },
        },
      }),
    );
    assert.deepEqual(
      list.lint({ mode: 'mcp' }).map((found) => [found.code, found.pointer]),
      [
        ['private_field', '/query/where/rules/0/field'],
        ['source_link_hidden', '/viz/showSource'],
        ['hardcoded_text', '/viz/caption'],
      ],
    );
    const chart = Block.from(jsonOf('chart', { viz: { kind: 'donut', showSource: false } }));
    assert.deepEqual(chart.lint({ mode: 'ui' }), []);
    assert.deepEqual(
      Block.from(jsonOf('list', { viz }))
        .lint({ mode: 'ui' })
        .map((found) => found.severity),
      ['error', 'warning'],
    );
  });
});
