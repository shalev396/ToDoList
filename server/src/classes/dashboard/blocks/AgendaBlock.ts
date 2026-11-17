import { BlockRegistry } from './BlockRegistry.js';
import { RowBlock } from './RowBlock.js';

/** Now, next and later today, then tomorrow: phone-first (catalog `agenda`). */
export class AgendaBlock extends RowBlock {
  readonly type = 'agenda' as const;

  static {
    BlockRegistry.instance.register('agenda', AgendaBlock, (json) => new AgendaBlock(json));
  }
}
