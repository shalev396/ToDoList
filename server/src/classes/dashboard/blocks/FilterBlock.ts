import { filterVariableIssues } from '../../../builder/catalog.js';
import { Block, type BlockIssue } from './Block.js';
import { BlockRegistry } from './BlockRegistry.js';
import type { BlockCapability, BlockControl, ControlBlock } from './contracts.js';

/**
 * Chips, a select or date presets that set a page variable (catalog `filter`): it drives the
 * blocks that listen to that variable, and shows no data of its own (it takes no query).
 */
export class FilterBlock extends Block implements ControlBlock {
  static override readonly capabilities: readonly BlockCapability[] = ['control'];

  readonly type = 'filter' as const;

  /** The `$page` variable it sets. */
  controls(): BlockControl | null {
    const { sets } = this.json;
    return sets === undefined ? null : { sets };
  }

  /** A filter sets a variable. */
  protected override checkSpecific(): BlockIssue[] {
    return filterVariableIssues(this.json);
  }

  static {
    BlockRegistry.instance.register('filter', FilterBlock, (json) => new FilterBlock(json));
  }
}
