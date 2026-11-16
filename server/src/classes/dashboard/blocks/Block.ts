/**
 * One block of a dashboard (BUILDER.md §4), as an immutable value object over its stored JSON.
 * Every block type is its own class (the 14 of BLOCK_TYPES), so what a block must meet is decided by
 * polymorphism instead of a switch on its type: `Block.from(json)` makes the class of the block's
 * type (BlockRegistry), and a type this code does not know gets UnknownBlock.
 *
 * Two template methods, each the steps every block shares around a hook its class overrides:
 * - `check()`, the catalog and the compiler (validation layers 2–3, BUILDER.md §8): the type's
 *   catalog entry (its viz schema, then its query rule: a data block has a query or a saved view,
 *   any other block takes none), then `checkSpecific()` (a filter sets a variable, an action names
 *   its action), then the embedded query compiled against the whitelist, never run;
 * - `lint(scope)` (layer 4): the field paths it names, then `lintSpecific()` (a block that renders
 *   rows keeps its source link), then its text.
 *
 * The block's shape (its fields and their types) is the document schema's, checked before any of
 * this (DocCheck). The rules themselves stay in the builder's pure modules (catalog, compile, lint):
 * these classes decide which apply to a type, and in which order. Pointers are relative to the
 * block; DocCheck puts them under `/blocks/<i>`.
 */
import { queryRuleIssues, vizIssues, type CatalogIssue } from '../../../builder/catalog.js';
import { lintFields, lintText, type LintIssue, type LintScope } from '../../../builder/lint.js';
import type { BlockType, Block as BlockJson } from '../../../types/builder.js';
import { Query } from '../Query.js';
import { BlockRegistry } from './BlockRegistry.js';
import type { BlockCapability } from './contracts.js';
import { deepFreeze } from '../../../utils/deepFreeze.js';

/** One issue of a block's check: where (relative to the block) and why. */
export type BlockIssue = CatalogIssue;

export abstract class Block {
  /**
   * The contracts (contracts.ts) this class implements, which the runtime can't see:
   * blocks.test.ts holds every class to them.
   */
  static readonly capabilities: readonly BlockCapability[] = [];

  readonly #json: Readonly<BlockJson>;
  readonly #query: Query | null;

  protected constructor(json: BlockJson) {
    this.#json = deepFreeze(structuredClone(json));
    this.#query = json.query === undefined ? null : Query.from(json.query);
  }

  /** The class of the block's type (BlockRegistry), frozen; an unknown type: UnknownBlock. */
  static from(json: BlockJson): Block {
    return BlockRegistry.instance.create(json);
  }

  abstract readonly type: BlockType;

  get id(): string {
    return this.#json.id;
  }

  get title(): string {
    return this.#json.title;
  }

  /** The block's JSON exactly as it was given (and is stored): a copy. */
  toJSON(): BlockJson {
    return structuredClone(this.#json);
  }

  /** The JSON, frozen, for the steps and the contracts of the subclasses. */
  protected get json(): Readonly<BlockJson> {
    return this.#json;
  }

  /** The embedded query, or null (a saved view instead, or none). */
  protected get embeddedQuery(): Query | null {
    return this.#query;
  }

  // ─── check (template method) ───────────────────────────────────────────────

  /** Every catalog and compiler issue of this block, in the order above. */
  check(): BlockIssue[] {
    return [...this.catalogIssues(), ...this.checkSpecific(), ...this.queryIssues()];
  }

  /** The type's catalog entry: the viz fits its schema, then the query rule. */
  protected catalogIssues(): BlockIssue[] {
    return [...vizIssues(this.#json), ...queryRuleIssues(this.#json)];
  }

  /** The rules of this type alone: none, unless the class has some. */
  protected checkSpecific(): BlockIssue[] {
    return [];
  }

  /** The embedded query compiled against the whitelist for this type (never run). */
  protected queryIssues(): BlockIssue[] {
    const issue = this.#query?.compileIssue(this.#json.type) ?? null;
    return issue === null ? [] : [{ pointer: `/query${issue.pointer}`, message: issue.message }];
  }

  // ─── lint (template method) ────────────────────────────────────────────────

  /** Every lint issue of this block in the actor's mode, in the order above. */
  lint(scope: LintScope): LintIssue[] {
    return [
      ...lintFields(this.#json, scope),
      ...this.lintSpecific(),
      ...lintText(this.#json, scope),
    ];
  }

  /** The lint of this type alone: none, unless the class has some. */
  protected lintSpecific(): LintIssue[] {
    return [];
  }
}
