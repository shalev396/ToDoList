import type { DateRange } from '../../../types/builder.js';
import { BlockRegistry } from './BlockRegistry.js';
import type { BlockCapability, TimeBlock } from './contracts.js';
import { QueryBlock } from './QueryBlock.js';

/**
 * Today's events on a 24-hour clock, its needle at now (catalog `clock`). It reads a query like
 * any data block (the catalog requires one) and draws it on a time face.
 */
export class ClockBlock extends QueryBlock implements TimeBlock {
  static override readonly capabilities: readonly BlockCapability[] = ['data', 'time'];

  readonly type = 'clock' as const;

  get range(): DateRange | null {
    return this.json.query?.dateRange ?? null;
  }

  static {
    BlockRegistry.instance.register('clock', ClockBlock, (json) => new ClockBlock(json));
  }
}
