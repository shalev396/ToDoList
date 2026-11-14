import { createContext, useContext } from 'react';
import type { BlockRegistryEntry } from './types';

/**
 * The registry entry of the block being rendered, given by the grid's BlockSlot. What the
 * registry itself loads (block components, and `useBlockData` under them) reads its entry here:
 * importing the registry from there would close an import cycle (src/importCycles.test.ts).
 */
export const BlockEntryContext = createContext<BlockRegistryEntry | null>(null);

/** The entry of the block being rendered; null outside a BlockSlot. */
export function useBlockEntry(): BlockRegistryEntry | null {
  return useContext(BlockEntryContext);
}
