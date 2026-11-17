/**
 * Which class stands for each block type (factory + registry), as IntegrationRegistry does for the
 * providers: `Block.from(json)` asks here, so DocCheck programs to the base type and gets the type's
 * subclass. Each class registers itself, with a factory (its constructor is not public), when its
 * module loads; blocks/index.ts loads them all.
 *
 * A type this code does not know (none of BLOCK_TYPES) gets the fallback, UnknownBlock. A known type
 * whose class is not registered is an error, never the fallback: its rules would be skipped.
 *
 * Registration happens once (phase 6b review M4): a second class or factory for a type, the same
 * class's included (a subclass's factory could stand in for it), and a second fallback are
 * refused, so no module loaded later can swap the rules every later request is checked by. Once
 * every class has registered, blocks/index.ts seals the registry: nothing registers after that.
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
  #sealed = false;

  private constructor() {
    // One instance: BlockRegistry.instance.
  }

  /** The class of `type`, once: any second registration for the type is refused. */
  register(type: BlockType, cls: BlockClass, factory: BlockFactory): void {
    if (this.#classes.has(type)) {
      throw new Error(`A block class for "${type}" is already registered`);
    }
    this.#assertOpen(`a block class for "${type}"`);
    this.#classes.set(type, { cls, factory });
  }

  /** The class for the types this code does not know, once. */
  registerFallback(factory: BlockFactory): void {
    if (this.#fallback !== null) throw new Error('The fallback block class is already registered');
    this.#assertOpen('the fallback block class');
    this.#fallback = factory;
  }

  /**
   * Closes the registry once every class has registered (blocks/index.ts, after loading them all):
   * no class registers after it. An incomplete registry (a type of BLOCK_TYPES without its class,
   * or no fallback) refuses to close, so a missing class fails as the module loads, not later.
   */
  seal(): void {
    const missing = BLOCK_TYPES.filter((type) => !this.#classes.has(type));
    if (missing.length > 0 || this.#fallback === null) {
      throw new Error(
        `The block registry is incomplete: ${[...missing, ...(this.#fallback === null ? ['the fallback'] : [])].join(', ')}`,
      );
    }
    this.#sealed = true;
  }

  /** Whether it is closed (seal): every class is in, and nothing more registers. */
  get isSealed(): boolean {
    return this.#sealed;
  }

  #assertOpen(what: string): void {
    if (this.#sealed) throw new Error(`The block registry is sealed: ${what} cannot register now`);
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
