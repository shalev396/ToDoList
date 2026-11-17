import { BlockRegistry } from './BlockRegistry.js';
import { QueryBlock } from './QueryBlock.js';

/** Hours per day over the visible week: calendar events plus estimates (catalog `workload`). */
export class WorkloadBlock extends QueryBlock {
  readonly type = 'workload' as const;

  static {
    BlockRegistry.instance.register('workload', WorkloadBlock, (json) => new WorkloadBlock(json));
  }
}
