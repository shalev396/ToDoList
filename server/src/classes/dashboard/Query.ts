/**
 * A saved view's query (FRONTEND.md §4, DATA.md §3.13), as an immutable value object: builder
 * query JSON that compiles against the whitelist. It is only ever checked here, never run: the
 * workspace query runs it as the viewer (QueryTarget). Pure.
 */
import { compileQuery, parseQuery } from '../../builder/compile.js';
import { OpValidationError, QueryValidationError } from '../../builder/errors.js';
import { validationContext } from '../../builder/validate.js';
import { stableStringify } from '../../utils/stableStringify.js';
import type { Query as QueryJson } from '../../types/builder.js';

/** Freezes a value and everything it holds. */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

export class Query {
  readonly #json: Readonly<QueryJson>;

  private constructor(json: QueryJson) {
    this.#json = deepFreeze(structuredClone(json));
    Object.freeze(this);
  }

  /**
   * The query as sent, parsed and compiled against the whitelist (never run): 400 with a pointer
   * under `/query` when it doesn't.
   */
  static parse(input: unknown): Query {
    try {
      const query = parseQuery(input);
      compileQuery(query, validationContext());
      return new Query(query);
    } catch (error) {
      if (error instanceof QueryValidationError) {
        throw new OpValidationError(`/query${error.pointer}`, error.reason);
      }
      throw error;
    }
  }

  /** A stored query, as it was saved (it passed `parse` when written). */
  static from(stored: Readonly<Record<string, unknown>>): Query {
    return new Query(stored as QueryJson);
  }

  /** The query JSON, a copy. */
  toJSON(): QueryJson {
    return structuredClone(this.#json);
  }

  /** The same query, compared canonically: the order of an object's keys doesn't count. */
  equals(other: Query | null | undefined): boolean {
    return (
      other !== null &&
      other !== undefined &&
      stableStringify(other.#json) === stableStringify(this.#json)
    );
  }
}
