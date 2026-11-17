import { BlockRegistry } from './BlockRegistry.js';
import { RowBlock } from './RowBlock.js';

/** A list of items or containers, a row each (catalog `list`). */
export class ListBlock extends RowBlock {
  readonly type = 'list' as const;

  static {
    BlockRegistry.instance.register('list', ListBlock, (json) => new ListBlock(json));
  }
}
