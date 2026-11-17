import type { DateRange } from '../../../types/builder.js';
import { BlockRegistry } from './BlockRegistry.js';
import type { BlockCapability, TimeBlock } from './contracts.js';
import { RowBlock } from './RowBlock.js';

/**
 * Items on a week or month grid over the page's range, `$page.range` (catalog `calendar`): rows
 * that link to their source, drawn on a time face.
 */
export class CalendarBlock extends RowBlock implements TimeBlock {
  static override readonly capabilities: readonly BlockCapability[] = ['data', 'time'];

  readonly type = 'calendar' as const;

  get range(): DateRange | null {
    return this.json.query?.dateRange ?? null;
  }

  static {
    BlockRegistry.instance.register('calendar', CalendarBlock, (json) => new CalendarBlock(json));
  }
}
