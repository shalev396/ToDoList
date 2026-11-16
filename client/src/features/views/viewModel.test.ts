import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import type { Block, PageView } from '@api-types/builder.ts';
import type { DashboardView } from '@api-types/dashboards.ts';
import {
  addedView,
  blocksOfView,
  canAddBlock,
  canAddView,
  layoutsOfBlocks,
  MAX_VIEWS,
  resolveView,
  rigidBlock,
  scopedDashboard,
  summaryBlocks,
  viewOfBlock,
  viewTabs,
} from './viewModel.ts';

const block = (id: string, type: Block['type'] = 'note'): Block => ({
  id,
  type,
  title: id,
  viz: { kind: type },
});

const list: PageView = { id: 'vw_list', type: 'list', title: 'List', blockIds: ['blk_l'] };
const dash: PageView = { id: 'vw_dash', type: 'dashboard', title: 'Mine', blockIds: ['blk_d1'] };

function page(views: PageView[]): DashboardView {
  return {
    blocks: [block('blk_s1'), block('blk_s2'), block('blk_l', 'list'), block('blk_d1')],
    layouts: {
      lg: ['blk_s1', 'blk_s2', 'blk_d1'].map((i, y) => ({ i, x: 0, y, w: 4, h: 2 })),
      md: [],
      sm: [],
    },
    views,
  } as unknown as DashboardView;
}

describe('view tabs', () => {
  it('puts the Summary first and fixed, then the views in order', () => {
    const tabs = viewTabs(page([list, dash]));
    assert.deepEqual(
      tabs.map((tab) => [tab.id, tab.fixed]),
      [
        ['summary', true],
        ['vw_list', false],
        ['vw_dash', false],
      ],
    );
    assert.equal(viewTabs(page([]))[0]?.id, 'summary');
  });

  it('opens the Summary for no param, an unknown one, and "summary"', () => {
    const dashboard = page([list]);
    assert.equal(resolveView(dashboard, null), null);
    assert.equal(resolveView(dashboard, 'vw_gone'), null);
    assert.equal(resolveView(dashboard, 'summary'), null);
    assert.equal(resolveView(dashboard, 'vw_list')?.id, 'vw_list');
  });
});

describe('which blocks a view shows', () => {
  const dashboard = page([list, dash]);

  it('shows the Summary the blocks no view names', () => {
    assert.deepEqual(
      summaryBlocks(dashboard).map((b) => b.id),
      ['blk_s1', 'blk_s2'],
    );
  });

  it('shows a view its own blocks', () => {
    assert.deepEqual(
      blocksOfView(dashboard, dash).map((b) => b.id),
      ['blk_d1'],
    );
    assert.equal(rigidBlock(dashboard, list)?.id, 'blk_l');
    assert.equal(rigidBlock(dashboard, dash), null);
  });

  it('scopes the layouts and the page to one grid', () => {
    const scoped = scopedDashboard(dashboard, dash);
    assert.deepEqual(
      scoped.dashboard.blocks.map((b) => b.id),
      ['blk_d1'],
    );
    assert.deepEqual(
      scoped.layouts.lg.map((item) => item.i),
      ['blk_d1'],
    );
    assert.deepEqual(
      layoutsOfBlocks(dashboard.layouts, summaryBlocks(dashboard)).lg.map((item) => item.i),
      ['blk_s1', 'blk_s2'],
    );
  });

  it('finds the view a block is in', () => {
    assert.equal(viewOfBlock(dashboard, 'blk_d1')?.id, 'vw_dash');
    assert.equal(viewOfBlock(dashboard, 'blk_s1'), null);
  });
});

describe('limits mirrored from the server', () => {
  it('counts the Summary in viewsPerPage', () => {
    const views = Array.from({ length: MAX_VIEWS - 2 }, (_, i) => ({
      ...list,
      id: `vw_${String(i)}`,
    }));
    assert.equal(canAddView(page(views)), true);
    assert.equal(canAddView(page([...views, { ...list, id: 'vw_last' }])), false);
  });

  it('caps each grid at 40 blocks', () => {
    const many = Array.from({ length: 40 }, (_, i) => block(`blk_${String(i)}`));
    const full = { ...page([]), blocks: many };
    assert.equal(canAddBlock(full, null), false);
    assert.equal(canAddBlock(page([dash]), dash), true);
  });
});

describe('opening a new view', () => {
  it('finds the view that was added', () => {
    assert.equal(addedView(page([list]), page([list, dash]))?.id, 'vw_dash');
    assert.equal(addedView(page([list]), page([list])), null);
  });
});
