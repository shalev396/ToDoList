import type { ComponentType, LazyExoticComponent } from 'react';
import type { LucideIcon } from 'lucide-react';
import type { Block, BlockType } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';

/** A size in grid cells. */
export interface GridSize {
  w: number;
  h: number;
}

/**
 * What the grid gives every block component. The block reads its page variables with
 * `usePageVars()`, fetches with `useBlockData(dashboard, block, vars)` and renders `BlockFrame`,
 * which adds the edit-mode handle and menu on its own. Its own registry entry (icon, sizes) comes
 * from `useBlockEntry()`: a block never imports the registry, which loads it (no import cycles,
 * src/importCycles.test.ts).
 */
export interface BlockComponentProps {
  dashboard: DashboardView;
  block: Block;
  /** The block's size on the current breakpoint's grid, in cells. */
  size: GridSize;
  /** The page is in edit mode: the block may quiet its own controls. */
  editing: boolean;
}

export type BlockComponent = ComponentType<BlockComponentProps>;

/** One block type (FRONTEND.md §5): adding a type is one entry here plus one on the server. */
export interface BlockRegistryEntry {
  /** Loaded on first use, so a page only downloads the blocks it shows. */
  component: LazyExoticComponent<BlockComponent>;
  icon: LucideIcon;
  /** A new block's size on the 12-column grid (the server catalog's size, checked by a test). */
  defaultSize: GridSize;
  /** The smallest size a resize may reach on the 12- and 8-column grids. */
  minSize: GridSize;
  /** Refetch the block's data this often, in ms (the clock and calendar: every minute). */
  refetchIntervalMs?: number;
}

/** One agent group's file: exactly its block types. */
export type BlockRegistryPart<T extends BlockType> = Readonly<Record<T, BlockRegistryEntry>>;
