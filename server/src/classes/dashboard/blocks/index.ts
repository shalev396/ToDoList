/**
 * The Block hierarchy (docs/design/CLASSES.md §6): the abstract Block, its contracts (DataBlock,
 * TimeBlock, ControlBlock), the registry, and one class per block type. Importing this module loads
 * every class, so each is registered before `Block.from` is asked; DocCheck (which checks a
 * document's blocks) and Dashboard (which hands its blocks out as these classes) import it. Not
 * handed on by the dashboard barrel: blocks are checked through DocCheck. Once every class has
 * registered (the modules above load before this one's body), the registry is sealed: nothing
 * registers after it (BlockRegistry#seal).
 */
import { BlockRegistry } from './BlockRegistry.js';

export { Block, type BlockIssue } from './Block.js';
export { BlockRegistry, type BlockClass, type BlockFactory } from './BlockRegistry.js';
export {
  isControlBlock,
  isDataBlock,
  isTimeBlock,
  type BlockCapability,
  type BlockControl,
  type ControlBlock,
  type DataBlock,
  type TimeBlock,
} from './contracts.js';
export { QueryBlock } from './QueryBlock.js';
export { RowBlock } from './RowBlock.js';
export { ListBlock } from './ListBlock.js';
export { TableBlock } from './TableBlock.js';
export { KanbanBlock } from './KanbanBlock.js';
export { CalendarBlock } from './CalendarBlock.js';
export { ChartBlock } from './ChartBlock.js';
export { ClockBlock } from './ClockBlock.js';
export { CounterBlock } from './CounterBlock.js';
export { DeadlinesBlock } from './DeadlinesBlock.js';
export { NoteBlock } from './NoteBlock.js';
export { FilterBlock } from './FilterBlock.js';
export { ActionBlock } from './ActionBlock.js';
export { TimelineBlock } from './TimelineBlock.js';
export { AgendaBlock } from './AgendaBlock.js';
export { WorkloadBlock } from './WorkloadBlock.js';
export { UnknownBlock } from './UnknownBlock.js';

BlockRegistry.instance.seal();
