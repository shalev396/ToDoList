import type { BlockType } from '@api-types/builder';
import { controlBlocks } from './registry/controlBlocks';
import { dataBlocks } from './registry/dataBlocks';
import { timeBlocks } from './registry/timeBlocks';
import type { BlockRegistryEntry, GridSize } from './registry/types';

/**
 * Block type → its component, icon, sizes and refresh (FRONTEND.md §5). Pages and the grid look
 * a type up here; they never switch on it. Three files, one per block agent group; a test checks
 * that every type is registered exactly once.
 */
export const BLOCK_REGISTRY: Readonly<Record<BlockType, BlockRegistryEntry>> = {
  ...dataBlocks,
  ...timeBlocks,
  ...controlBlocks,
};

/** The entry for a type the server sent; undefined for one this client does not know yet. */
export function blockEntry(type: string): BlockRegistryEntry | undefined {
  return Object.hasOwn(BLOCK_REGISTRY, type) ? BLOCK_REGISTRY[type as BlockType] : undefined;
}

const FALLBACK_SIZE: GridSize = { w: 4, h: 8 };
const FALLBACK_MIN: GridSize = { w: 1, h: 1 };

/** A new block's size on the 12-column grid. */
export function blockDefaultSize(type: string): GridSize {
  return blockEntry(type)?.defaultSize ?? FALLBACK_SIZE;
}

export function blockMinSize(type: string): GridSize {
  return blockEntry(type)?.minSize ?? FALLBACK_MIN;
}
