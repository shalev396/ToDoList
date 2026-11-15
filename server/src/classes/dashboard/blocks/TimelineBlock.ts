import { BlockRegistry } from './BlockRegistry.js';
import { RowBlock } from './RowBlock.js';

/** Items on a time axis, day by day (catalog `timeline`). */
export class TimelineBlock extends RowBlock {
  readonly type = 'timeline' as const;

  static {
    BlockRegistry.instance.register('timeline', TimelineBlock, (json) => new TimelineBlock(json));
  }
}
