import { actionNameIssues } from '../../../builder/catalog.js';
import { Block, type BlockIssue } from './Block.js';
import { BlockRegistry } from './BlockRegistry.js';
import type { BlockCapability, BlockControl, ControlBlock } from './contracts.js';

/**
 * A button that runs an action through the backend, never in a query (catalog `action`): sync
 * Google Calendar, refresh a source, open a source. It takes no query.
 */
export class ActionBlock extends Block implements ControlBlock {
  static override readonly capabilities: readonly BlockCapability[] = ['control'];

  readonly type = 'action' as const;

  /** The action it runs. */
  controls(): BlockControl | null {
    const { action } = this.json;
    return action === undefined ? null : { runs: action };
  }

  /** An action names its action. */
  protected override checkSpecific(): BlockIssue[] {
    return actionNameIssues(this.json);
  }

  static {
    BlockRegistry.instance.register('action', ActionBlock, (json) => new ActionBlock(json));
  }
}
