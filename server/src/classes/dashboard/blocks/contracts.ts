/**
 * The contracts of the Block classes (`implements`): what a block is beyond the base, as the plan
 * names them. DocCheck needs none of them (`check` and `lint` are the base's); code that needs a
 * block's query, the span it draws or what it drives asks the base type through the guards below
 * instead of switching on `type`.
 *
 * The runtime can't see `implements`: each class declares its contracts (`static capabilities`),
 * and blocks.test.ts holds the classes, these guards and the catalog to the same table.
 */
import type { BlockAction, DateRange } from '../../../types/builder.js';
import type { Query } from '../Query.js';
import type { Block } from './Block.js';

/** A block that shows data: from an embedded query or a saved view (the catalog's requiredQuery). */
export interface DataBlock {
  /** The embedded query, or null when the block reads a saved view instead (or names neither). */
  query(): Query | null;
  /** The saved view it reads instead of an embedded query, or null. */
  readonly savedViewId: string | null;
}

/** A block drawn on a time face: a calendar's grid, a 24-hour clock. */
export interface TimeBlock {
  /** The span it draws: its query's date range (a preset, `$page.range`, bounds), or null. */
  readonly range: DateRange | null;
}

/** What a control drives: the page variable a filter sets, or the action a button runs. */
export type BlockControl = { readonly sets: string } | { readonly runs: BlockAction };

/** A block that drives the page instead of showing data: a filter, an action button. */
export interface ControlBlock {
  /** What it drives, or null when it names nothing (its check says so). */
  controls(): BlockControl | null;
}

/** The contract names a class declares: DataBlock, TimeBlock, ControlBlock. */
export type BlockCapability = 'data' | 'time' | 'control';

const hasMethod = (value: object, name: string): boolean =>
  typeof (value as Record<string, unknown>)[name] === 'function';

export function isDataBlock(block: Block): block is Block & DataBlock {
  return hasMethod(block, 'query') && 'savedViewId' in block;
}

export function isTimeBlock(block: Block): block is Block & TimeBlock {
  return 'range' in block;
}

export function isControlBlock(block: Block): block is Block & ControlBlock {
  return hasMethod(block, 'controls');
}
