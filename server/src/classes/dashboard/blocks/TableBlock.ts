import { BlockRegistry } from './BlockRegistry.js';
import { RowBlock } from './RowBlock.js';

/** A table of items or containers, a row each; its columns are field paths (catalog `table`). */
export class TableBlock extends RowBlock {
  readonly type = 'table' as const;

  static {
    BlockRegistry.instance.register('table', TableBlock, (json) => new TableBlock(json));
  }
}
