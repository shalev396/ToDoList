import { BlockRegistry } from './BlockRegistry.js';
import { RowBlock } from './RowBlock.js';

/** A board: the items as cards, a column per group, `status` by default (catalog `kanban`). */
export class KanbanBlock extends RowBlock {
  readonly type = 'kanban' as const;

  static {
    BlockRegistry.instance.register('kanban', KanbanBlock, (json) => new KanbanBlock(json));
  }
}
