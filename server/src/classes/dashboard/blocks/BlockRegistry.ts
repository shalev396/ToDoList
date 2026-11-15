/**
 * Which class stands for each block type (factory + registry), as IntegrationRegistry does for the
 * providers: `Block.from(json)` asks here, so DocCheck programs to the base type and gets the type's
 * subclass. Each class registers itself, with a factory (its constructor is not public), when its
 * module loads; blocks/index.ts loads them all.
 *
 * A type this code does not know (none of BLOCK_TYPES) gets the fallback, UnknownBlock. A known type
 * whose class is not registered is an error, never the fallback: its rules would be skipped.
 */
import { BLOCK_TYPES, type BlockType, type Block as BlockJson } from '../../../types/builder.js';
import type { Block } from './Block.js';
import type { BlockCapability } from './contracts.js';

/** Makes the type's class from a block's JSON (a subclass's protected constructor, wrapped). */
export type BlockFactory = (json: BlockJson) => Block;

/** A block class: its contracts (`static capabilities`), its name and its prototype. */
export interface BlockClass {
  readonly capabilities: readonly BlockCapability[];
  readonly name: string;
  readonly prototype: Block;
}

const KNOWN: ReadonlySet<string> = new Set(BLOCK_TYPES);

/** The block, frozen: its fields are set (a subclass's too), and nothing changes them after. */
function frozen(block: Block): Block {
  Object.freeze(block);
  return block;
}

export class BlockRegistry {
  /** The one registry (a singleton: the classes register into it as their modules load). */
  static readonly instance = new BlockRegistry();

  readonly #classes = new Map<BlockType, { cls: BlockClass; factory: BlockFactory }>();
  #fallback: BlockFactory | null = null;

  private constructor() {
    // One instance: BlockRegistry.instance.
  }

  /** The class of `type`. A second, different one is refused. */
  register(type: BlockType, cls: BlockClass, factory: BlockFactory): void {
    const current = this.#classes.get(type);
    if (current !== undefined && current.cls !== cls) {
      throw new Error(`A block class for "${type}" is already registered`);
    }
    this.#classes.set(type, { cls, factory });
  }

  /** The class for the types this code does not know. */
  registerFallback(factory: BlockFactory): void {
    this.#fallback = factory;
  }

  /** The types with a class, sorted. */
  types(): BlockType[] {
    return [...this.#classes.keys()].sort();
  }

  /** The class registered for `type`. */
  classOf(type: BlockType): BlockClass {
    const entry = this.#classes.get(type);
    if (entry === undefined) throw new Error(`No block class is registered for "${type}"`);
    return entry.cls;
  }

  /** The block as its type's class, frozen. */
  create(json: BlockJson): Block {
    const entry = this.#classes.get(json.type);
    if (entry !== undefined) return frozen(entry.factory(json));
    if (KNOWN.has(json.type)) {
      throw new Error(
        `No block class is registered for "${json.type}": load classes/dashboard/blocks/index.js`,
      );
    }
    if (this.#fallback === null) throw new Error('No class is registered for unknown block types');
    return frozen(this.#fallback(json));
  }
}
