import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { vizKinds, vizOptions, withVizOption } from './viz.ts';

type Schema = Record<string, unknown>;

/** `vizSchema` as GET …/builder/catalog serves it (zod's toJSONSchema of VIZ_SCHEMAS). */
const SCHEMAS: Record<'list' | 'chart' | 'table' | 'kanban', Schema> = {
  list: {
    type: 'object',
    properties: {
      kind: { type: 'string', const: 'list' },
      visibleRows: { type: 'integer', minimum: 1, maximum: 200 },
      linkTo: { type: 'string', enum: ['group'] },
    },
    required: ['kind'],
  },
  chart: {
    type: 'object',
    properties: {
      kind: { type: 'string', enum: ['donut', 'bar', 'line', 'number'] },
      showTotal: { type: 'boolean' },
      legend: { type: 'string', enum: ['chips', 'list', 'none'] },
    },
    required: ['kind'],
  },
  table: {
    type: 'object',
    properties: {
      kind: { type: 'string', const: 'table' },
      columns: { maxItems: 20, type: 'array', items: { type: 'string', minLength: 1 } },
    },
    required: ['kind'],
  },
  kanban: { type: 'object', properties: { kind: { type: 'string', const: 'kanban' } } },
};
const json = (name: keyof typeof SCHEMAS): Schema => SCHEMAS[name];

describe('viz options from the catalog schema', () => {
  it('reads a list: a number with bounds and an enum', () => {
    const schema = json('list');
    assert.deepEqual(vizKinds(schema), ['list']);
    const options = vizOptions(schema);
    assert.deepEqual(
      options.map((o) => [o.name, o.input]),
      [
        ['visibleRows', 'integer'],
        ['linkTo', 'enum'],
      ],
    );
  });
  it('reads a chart: several kinds and an enum legend', () => {
    const schema = json('chart');
    assert.deepEqual(vizKinds(schema), ['donut', 'bar', 'line', 'number']);
    assert.deepEqual(
      vizOptions(schema).map((o) => [o.name, o.input]),
      [
        ['showTotal', 'boolean'],
        ['legend', 'enum'],
      ],
    );
  });
  it('reads a table: a list of column names', () => {
    const [columns] = vizOptions(json('table'));
    assert.equal(columns?.input, 'strings');
  });
  it('has no options for a block with none', () => {
    assert.deepEqual(vizOptions(json('kanban')), []);
  });
  it('sets and removes one option without touching the others', () => {
    const viz = { kind: 'list', visibleRows: 7 };
    assert.deepEqual(withVizOption(viz, 'visibleRows', 5), { kind: 'list', visibleRows: 5 });
    assert.deepEqual(withVizOption(viz, 'visibleRows', undefined), { kind: 'list' });
    assert.deepEqual(viz, { kind: 'list', visibleRows: 7 });
  });
});
