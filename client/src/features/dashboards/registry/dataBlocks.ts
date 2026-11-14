import { lazy } from 'react';
import { CalendarClock, ChartPie, Hash, List, SquareKanban, Table2 } from 'lucide-react';
import type { BlockRegistryPart } from './types';

/**
 * Data blocks: list, table, deadlines, counter, chart and kanban (plan T4.6, agent
 * group A). Each block is its own lazy chunk.
 */

export const dataBlocks: BlockRegistryPart<
  'list' | 'table' | 'deadlines' | 'counter' | 'chart' | 'kanban'
> = {
  list: {
    component: lazy(() => import('../blocks/ListBlock')),
    icon: List,
    defaultSize: { w: 4, h: 8 },
    minSize: { w: 3, h: 4 },
  },
  table: {
    component: lazy(() => import('../blocks/TableBlock')),
    icon: Table2,
    defaultSize: { w: 12, h: 8 },
    minSize: { w: 4, h: 4 },
  },
  deadlines: {
    component: lazy(() => import('../blocks/DeadlinesBlock')),
    icon: CalendarClock,
    defaultSize: { w: 4, h: 10 },
    minSize: { w: 3, h: 4 },
  },
  counter: {
    component: lazy(() => import('../blocks/CounterBlock')),
    icon: Hash,
    defaultSize: { w: 3, h: 4 },
    minSize: { w: 2, h: 3 },
  },
  chart: {
    component: lazy(() => import('../blocks/ChartBlock')),
    icon: ChartPie,
    defaultSize: { w: 4, h: 8 },
    minSize: { w: 3, h: 5 },
  },
  kanban: {
    component: lazy(() => import('../blocks/KanbanBlock')),
    icon: SquareKanban,
    defaultSize: { w: 12, h: 10 },
    minSize: { w: 4, h: 6 },
  },
};
