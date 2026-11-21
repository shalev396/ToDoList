import type { DateRange } from '../../../types/builder.js';
import { BlockRegistry } from './BlockRegistry.js';
import type { BlockCapability, TimeBlock } from './contracts.js';
import { RowBlock } from './RowBlock.js';

/**
 * A topic's painted time and its open to-dos (catalog `timesheet`): the areas and time blocks of
 * the visible week (`$page.range`) on a week grid, with the to-dos beside it to drag onto the
 * grid, which plans them (`overlay.plannedAt`). Rows that link to their source, drawn on a time
 * face, like the calendar. Its topic is the query's `topic` rule (`$page.topic` by default).
 */
export class TimesheetBlock extends RowBlock implements TimeBlock {
  static override readonly capabilities: readonly BlockCapability[] = ['data', 'time'];

  readonly type = 'timesheet' as const;

  get range(): DateRange | null {
    return this.json.query?.dateRange ?? null;
  }

  static {
    BlockRegistry.instance.register(
      'timesheet',
      TimesheetBlock,
      (json) => new TimesheetBlock(json),
    );
  }
}
