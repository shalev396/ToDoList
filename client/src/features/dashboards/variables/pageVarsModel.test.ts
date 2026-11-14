import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Block, PageView } from '@api-types/builder.ts';
import { buildPageVarEntries, varValueText } from './pageVarsModel.ts';
import type { PageVars } from './urlVars.ts';

const block = (id: string, patch: Partial<Block> = {}): Block => ({
  id,
  type: 'list',
  title: id,
  viz: { kind: 'list' },
  ...patch,
});

const filter = block('blk_filter', {
  type: 'filter',
  sets: '$page.course',
  viz: { kind: 'select', field: 'containerId' },
});
const chart = block('blk_chart', {
  type: 'chart',
  emits: { onSegmentClick: '$page.provider' },
  viz: { kind: 'donut' },
});
const list = block('blk_list', { listen: ['$page.course', '$page.provider'] });
const inView = block('blk_view', { listen: ['$page.course'] });
const view: PageView = { id: 'vw_a', type: 'list', title: 'My list', blockIds: ['blk_view'] };

function plain(entries: Record<string, string | null>): PageVars {
  return Object.assign(Object.create(null) as Record<string, string | null>, entries);
}

const dashboard = {
  vars: { range: 'this_week', course: null, topic: 't1' },
  blocks: [filter, chart, list, inView],
  views: [view],
};

describe('the page variables panel', () => {
  const entries = buildPageVarEntries({
    dashboard,
    vars: plain({ range: 'this_week', course: 'c1', topic: 't1', provider: 'jira' }),
    urlVars: plain({ course: 'c1', provider: 'jira' }),
    bound: new Set(['topic']),
  });
  const byName = (name: string) => entries.find((entry) => entry.name === name);

  it('lists the defaults, the URL, the route and the ones blocks name', () => {
    assert.deepEqual(
      entries.map((entry) => entry.name),
      ['course', 'provider', 'range', 'topic'],
    );
  });

  it('says where each value is set', () => {
    assert.equal(byName('course')?.origin, 'url');
    assert.equal(byName('provider')?.origin, 'url');
    assert.equal(byName('range')?.origin, 'default');
    assert.equal(byName('topic')?.origin, 'route');
  });

  it('names the blocks that set it: a filter, a chart click', () => {
    assert.deepEqual(byName('course')?.setters, [
      { blockId: 'blk_filter', title: 'blk_filter', type: 'filter', kind: 'filter' },
    ]);
    assert.equal(byName('provider')?.setters[0]?.kind, 'chartClick');
    assert.deepEqual(byName('range')?.setters, []);
  });

  it('names the blocks and the views that listen to it', () => {
    const listeners = byName('course')?.listeners ?? [];
    assert.deepEqual(
      listeners.map((entry) => [entry.blockId, entry.viewId]),
      [
        ['blk_list', null],
        ['blk_view', 'vw_a'],
      ],
    );
    assert.equal(listeners[1]?.viewTitle, 'My list');
  });

  it('lets a variable be cleared unless the route fixes it or it is unset', () => {
    assert.equal(byName('course')?.clearable, true);
    assert.equal(byName('range')?.clearable, true);
    assert.equal(byName('topic')?.clearable, false);
    const unset = buildPageVarEntries({
      dashboard,
      vars: plain({ range: 'this_week', course: null }),
      urlVars: plain({}),
      bound: new Set(),
    });
    assert.equal(unset.find((entry) => entry.name === 'course')?.origin, 'unset');
    assert.equal(unset.find((entry) => entry.name === 'course')?.clearable, false);
  });

  it('is empty for a page with no variables', () => {
    assert.deepEqual(
      buildPageVarEntries({
        dashboard: { vars: {}, blocks: [], views: [] },
        vars: plain({}),
        urlVars: plain({}),
        bound: new Set(),
      }),
      [],
    );
  });
});

describe('values as the panel shows them', () => {
  it('shows text, lists and ranges, and nothing for unset', () => {
    assert.equal(varValueText('jira'), 'jira');
    assert.equal(varValueText(['jira', 'github']), 'jira, github');
    assert.equal(
      varValueText({ from: '2026-11-01T00:00:00Z', to: '2026-11-08T00:00:00Z' }),
      '2026-11-01T00:00:00Z → 2026-11-08T00:00:00Z',
    );
    assert.equal(varValueText(null), '');
    assert.equal(varValueText(undefined), '');
    assert.equal(varValueText(3), '3');
  });
});
