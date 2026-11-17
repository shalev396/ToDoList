import { BlockRegistry } from './BlockRegistry.js';
import { QueryBlock } from './QueryBlock.js';

/** A donut, bar, line or number over grouped, aggregated items (catalog `chart`). */
export class ChartBlock extends QueryBlock {
  readonly type = 'chart' as const;

  static {
    BlockRegistry.instance.register('chart', ChartBlock, (json) => new ChartBlock(json));
  }
}
