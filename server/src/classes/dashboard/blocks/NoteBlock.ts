import { Block } from './Block.js';
import { BlockRegistry } from './BlockRegistry.js';

/**
 * Free text (catalog `note`): with titles, the only text a person writes on a dashboard. Static:
 * no query, no data, nothing it drives.
 */
export class NoteBlock extends Block {
  readonly type = 'note' as const;

  static {
    BlockRegistry.instance.register('note', NoteBlock, (json) => new NoteBlock(json));
  }
}
