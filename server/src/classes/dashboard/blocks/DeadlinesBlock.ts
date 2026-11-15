import { BlockRegistry } from './BlockRegistry.js';
import { RowBlock } from './RowBlock.js';

/** What is due: items with a due date, the overdue ones first (catalog `deadlines`). */
export class DeadlinesBlock extends RowBlock {
  readonly type = 'deadlines' as const;

  static {
    BlockRegistry.instance.register(
      'deadlines',
      DeadlinesBlock,
      (json) => new DeadlinesBlock(json),
    );
  }
}
