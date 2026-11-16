/**
 * Page views (H3), as the client reads them. A page has the Summary (its own grid: the blocks no
 * view names) and `views[]` after it: rigid views (one block, no grid) and dashboard views (their
 * own grids). The blocks of every view live in the page's flat `blocks` and `layouts`, so this
 * only picks which ones a view shows. Pure: the tabs, the grid and the tests share it.
 */
import {
  CAPS,
  SUMMARY_VIEW_ID,
  VIEW_BLOCK_TYPE,
  isRigidViewType,
  type Block,
  type Layouts,
  type PageView,
  type ViewType,
} from '@api-types/builder.ts';
import type { DashboardView } from '@api-types/dashboards.ts';

export { SUMMARY_VIEW_ID, VIEW_BLOCK_TYPE, isRigidViewType };

/** The URL param that names the open view. */
export const VIEW_PARAM = 'view';

/** The view types "Custom" offers, rigid ones first, in the order the picker shows them. */
export const CUSTOM_VIEW_TYPES: readonly ViewType[] = [
  'list',
  'board',
  'timeline',
  'calendar',
  'table',
  'agenda',
  'workload',
  'dashboard',
];

type ViewsOf = Pick<DashboardView, 'views' | 'blocks' | 'layouts'>;

/** One tab: the Summary, or a stored view. */
export interface ViewTab {
  id: string;
  type: ViewType | 'summary';
  /** The stored title; null for the Summary (the client names it). */
  title: string | null;
  fixed: boolean;
}

/** The tabs in order: the Summary first, always, then the views as stored. */
export function viewTabs(dashboard: Pick<DashboardView, 'views'>): ViewTab[] {
  return [
    { id: SUMMARY_VIEW_ID, type: 'summary', title: null, fixed: true },
    ...dashboard.views.map(
      (view): ViewTab => ({ id: view.id, type: view.type, title: view.title, fixed: false }),
    ),
  ];
}

/** The open view: the one `?view=` names, else (or when it is gone) the Summary. */
export function resolveView(
  dashboard: Pick<DashboardView, 'views'>,
  wanted: string | null,
): PageView | null {
  return dashboard.views.find((view) => view.id === wanted) ?? null;
}

/** The blocks of the Summary: those no view names. */
export function summaryBlocks(dashboard: Pick<DashboardView, 'views' | 'blocks'>): Block[] {
  const inViews = new Set(dashboard.views.flatMap((view) => view.blockIds));
  return dashboard.blocks.filter((block) => !inViews.has(block.id));
}

/** The blocks a view shows (the Summary's for null), in the view's own order. */
export function blocksOfView(dashboard: ViewsOf, view: PageView | null): Block[] {
  if (view === null) {
    return summaryBlocks(dashboard);
  }
  const byId = new Map(dashboard.blocks.map((block) => [block.id, block]));
  return view.blockIds.flatMap((id) => {
    const block = byId.get(id);
    return block === undefined ? [] : [block];
  });
}

/** The layouts of one grid: only the items of its blocks. */
export function layoutsOfBlocks(layouts: Layouts, blocks: readonly Block[]): Layouts {
  const ids = new Set(blocks.map((block) => block.id));
  const only = (items: Layouts['lg']): Layouts['lg'] => items.filter((item) => ids.has(item.i));
  return { lg: only(layouts.lg), md: only(layouts.md), sm: only(layouts.sm) };
}

/**
 * The page as one view shows it: the same page with only that view's blocks. Block components read
 * `dashboard.id` and the block, so a view's blocks query and refresh exactly like the Summary's.
 */
export function scopedDashboard(
  dashboard: DashboardView,
  view: PageView | null,
): { dashboard: DashboardView; layouts: Layouts } {
  const blocks = blocksOfView(dashboard, view);
  return {
    dashboard: { ...dashboard, blocks },
    layouts: layoutsOfBlocks(dashboard.layouts, blocks),
  };
}

/** Views a page may hold, the Summary included (PLAN_LIMITS.viewsPerPage). */
export const MAX_VIEWS = CAPS.maxViews;

/** The Summary counts: a page with `views` views after it holds views + 1. */
export function canAddView(dashboard: Pick<DashboardView, 'views'>): boolean {
  return dashboard.views.length + 1 < MAX_VIEWS;
}

/** Whether a grid has room for one more block: the Summary and each dashboard view hold 40. */
export function canAddBlock(dashboard: ViewsOf, view: PageView | null): boolean {
  return blocksOfView(dashboard, view).length < CAPS.maxBlocks;
}

/** A view's block when it is rigid (the one block it holds), else null. */
export function rigidBlock(dashboard: ViewsOf, view: PageView): Block | null {
  return isRigidViewType(view.type) ? (blocksOfView(dashboard, view)[0] ?? null) : null;
}

/** The view a block is in (null: the Summary's). */
export function viewOfBlock(
  dashboard: Pick<DashboardView, 'views'>,
  blockId: string,
): PageView | null {
  return dashboard.views.find((view) => view.blockIds.includes(blockId)) ?? null;
}

/**
 * The view that is new in `after`, for opening it once it is added: the last one whose id `before`
 * lacked.
 */
export function addedView(
  before: Pick<DashboardView, 'views'>,
  after: Pick<DashboardView, 'views'>,
): PageView | null {
  const known = new Set(before.views.map((view) => view.id));
  return [...after.views].reverse().find((view) => !known.has(view.id)) ?? null;
}
