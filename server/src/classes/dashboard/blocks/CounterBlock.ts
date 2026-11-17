import { BlockRegistry } from './BlockRegistry.js';
import { QueryBlock } from './QueryBlock.js';

/** One number: an aggregate of the items, a count by default (catalog `counter`). */
export class CounterBlock extends QueryBlock {
  readonly type = 'counter' as const;

  static {
    BlockRegistry.instance.register('counter', CounterBlock, (json) => new CounterBlock(json));
  }
}
