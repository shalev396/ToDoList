import { lazy } from 'react';
import { ListFilter, MousePointerClick, StickyNote } from 'lucide-react';
import type { BlockRegistryPart } from './types';

/** Control blocks: filter, action and note (plan T4.8, agent group C). */
export const controlBlocks: BlockRegistryPart<'filter' | 'action' | 'note'> = {
  filter: {
    component: lazy(() => import('../blocks/FilterBlock')),
    icon: ListFilter,
    defaultSize: { w: 12, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  action: {
    component: lazy(() => import('../blocks/ActionBlock')),
    icon: MousePointerClick,
    defaultSize: { w: 3, h: 3 },
    minSize: { w: 2, h: 2 },
  },
  note: {
    component: lazy(() => import('../blocks/NoteBlock')),
    icon: StickyNote,
    defaultSize: { w: 6, h: 4 },
    minSize: { w: 2, h: 2 },
  },
};
