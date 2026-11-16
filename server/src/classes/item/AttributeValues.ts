/**
 * An item's custom attribute values (H4), as an immutable composite value object: attribute key →
 * value, kept in the item's overlay, never written to a provider. A value is checked against its
 * workspace's definition when it is set (`checked`: one `AttributeDefinition` class per type
 * decides what fits and how it is stored), so the values an item holds are always ones that
 * fitted. Two sets of values are equal when they hold the same keys with the same values. Pure.
 */
import { AppError } from '../../errors/AppError.js';
import { redactString } from '../../services/secretPatterns.js';
import type { AttributeDefinitions } from '../workspace/AttributeDefinitions.js';

/** One value, compared as stored (a date by its instant). */
function sameValue(a: unknown, b: unknown): boolean {
  if (a instanceof Date || b instanceof Date) {
    return a instanceof Date && b instanceof Date && a.getTime() === b.getTime();
  }
  return JSON.stringify(a) === JSON.stringify(b);
}

export class AttributeValues {
  readonly #values: Readonly<Record<string, unknown>>;

  private constructor(values: Readonly<Record<string, unknown>>) {
    this.#values = Object.freeze({ ...values });
    Object.freeze(this);
  }

  /** The values an item's overlay holds (checked when they were set). */
  static of(stored: Readonly<Record<string, unknown>>): AttributeValues {
    return new AttributeValues(stored);
  }

  /**
   * An edit's values (key → value, null clears one) checked against the workspace's definitions:
   * an unknown key or a value that does not fit is a 400 naming the key. Each value as the
   * overlay stores it (a date becomes a Date; the rest as it is).
   */
  static checked(
    values: Readonly<Record<string, unknown>>,
    definitions: AttributeDefinitions,
  ): AttributeValues {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(values)) {
      const definition = definitions.find(key);
      if (definition === undefined) throw new AppError(400, `Unknown attribute: ${key}`);
      const problem = definition.check(value);
      if (problem !== null) throw new AppError(400, problem);
      out[key] = value === null ? null : definition.store(value);
    }
    return new AttributeValues(out);
  }

  /** The keys it holds a value (or a clear) for. */
  get keys(): string[] {
    return Object.keys(this.#values);
  }

  /** The value of one attribute: undefined when it holds none. */
  get(key: string): unknown {
    return Object.hasOwn(this.#values, key) ? this.#values[key] : undefined;
  }

  /** Same keys, same values. */
  equals(other: AttributeValues): boolean {
    const keys = this.keys;
    return (
      keys.length === other.keys.length &&
      keys.every(
        (key) => Object.hasOwn(other.#values, key) && sameValue(this.get(key), other.get(key)),
      )
    );
  }

  /** What the overlay stores (`overlay.attrs`, or a patch of it: null clears a key). */
  toStored(): Record<string, unknown> {
    return { ...this.#values };
  }

  /** As the API shows them: no empty value, dates as ISO strings, text redacted. */
  toView(): Record<string, unknown> {
    const out: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(this.#values)) {
      if (value === null || value === undefined) continue;
      if (value instanceof Date) out[key] = value.toISOString();
      else out[key] = typeof value === 'string' ? redactString(value) : value;
    }
    return out;
  }
}
