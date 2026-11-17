import { createContext, useContext, type ReactNode } from 'react';
import type { TFunction } from 'i18next';
import type { Block } from '@api-types/builder';
import type { GridSize } from './registry/types';
import type { SourceState } from './removedSource';

/**
 * What the grid adds around a block: in edit mode, the drag handle and the block menu (move,
 * resize, edit, remove). BlockFrame reads it and places them in its title row, so a block
 * component gets edit mode by rendering BlockFrame, with nothing to wire.
 */
export interface BlockChrome {
  editing: boolean;
  /** The drag handle, at the start of the title row (edit mode, pointer). */
  handle: ReactNode;
  /** The grid's menu for this block (edit mode). */
  menu: ReactNode;
  /** The block's size on the current grid, in cells; undefined outside a grid. */
  size: GridSize | undefined;
  /** A filter this block listens to is focused or hovered: draw the outline. */
  outlined: boolean;
  /**
   * "A source was removed" (a connector's integration is gone, or Stop sharing took it off) or
   * "No source" (it names none, so it reads nothing): removedSource.ts.
   */
  source: SourceState;
}

const NO_CHROME: BlockChrome = {
  editing: false,
  handle: null,
  menu: null,
  size: undefined,
  outlined: false,
  source: null,
};

export const BlockChromeContext = createContext<BlockChrome>(NO_CHROME);

export function useBlockChrome(): BlockChrome {
  return useContext(BlockChromeContext);
}

/** A block's title, or the name of its type when it has none (titles may be empty). */
export function blockTitle(block: Pick<Block, 'title' | 'type'>, t: TFunction): string {
  const title = block.title.trim();
  return title === '' ? t(`blocks.types.${block.type}`) : title;
}
