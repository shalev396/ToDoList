import { zodIssues } from '../../../builder/errors.js';
import { BlockSchema, type Block as BlockJson } from '../../../types/builder.js';
import { Block, type BlockIssue } from './Block.js';
import { BlockRegistry } from './BlockRegistry.js';

/**
 * A block of a type this code does not know (as UnknownAttribute is for attributes): a Null
 * Object. The document schema refuses it before any block is checked (DocCheck), so a document
 * never gets here; made here, its check says what the schema says, the same issue at its `type`,
 * and nothing more: the rules of a type it does not know (its catalog entry, its query compiled
 * for it), it can't apply. So it answers the whole check, not the base template's steps, which
 * stay the base's own.
 */
export class UnknownBlock extends Block {
  /** The type as given: none of BLOCK_TYPES. */
  readonly type: string;

  private constructor(json: BlockJson) {
    super(json);
    this.type = json.type;
  }

  /** The schema's issue for a type outside the catalog. */
  override check(): BlockIssue[] {
    const parsed = BlockSchema.shape.type.safeParse(this.type);
    if (parsed.success) return [];
    return zodIssues(parsed.error).map(({ pointer, reason }) => ({
      pointer: `/type${pointer}`,
      message: reason,
    }));
  }

  static {
    BlockRegistry.instance.registerFallback((json) => new UnknownBlock(json));
  }
}
