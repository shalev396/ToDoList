import { zodIssues } from '../../../builder/errors.js';
import { BlockSchema, type BlockType, type Block as BlockJson } from '../../../types/builder.js';
import { Block, type BlockIssue } from './Block.js';
import { BlockRegistry } from './BlockRegistry.js';

/**
 * A block of a type this code does not know (as UnknownAttribute is for attributes). The document
 * schema refuses it before any block is checked (DocCheck), so a document never gets here; made
 * here, it says what the schema says, the same issue at its `type`, and nothing more: the rules
 * of a type it does not know, it can't apply.
 */
export class UnknownBlock extends Block {
  /** The type as given: none of BLOCK_TYPES. */
  readonly type: BlockType;

  private constructor(json: BlockJson) {
    super(json);
    this.type = json.type;
  }

  /** The schema's issue for a type outside the catalog. */
  protected override catalogIssues(): BlockIssue[] {
    const parsed = BlockSchema.shape.type.safeParse(this.type);
    if (parsed.success) return [];
    return zodIssues(parsed.error).map(({ pointer, reason }) => ({
      pointer: `/type${pointer}`,
      message: reason,
    }));
  }

  /** Its query compiles for no type: nothing to say beyond the type. */
  protected override queryIssues(): BlockIssue[] {
    return [];
  }

  static {
    BlockRegistry.instance.registerFallback((json) => new UnknownBlock(json));
  }
}
