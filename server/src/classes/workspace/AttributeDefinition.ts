/**
 * One custom attribute of a workspace (H4), as an immutable value object. Every type is its own
 * class, so what a value must look like (and how it is stored) is decided by polymorphism instead
 * of a switch: `AttributeDefinition.of(data)` makes the class for the stored type.
 *
 * `valueError` is the type's rule (null: the value fits); `check` adds the rule every type shares
 * (`null` always fits, it clears the value); `store` is the value as the overlay keeps it.
 */
import {
  ATTRIBUTE_TEXT_MAX,
  MAX_ATTRIBUTE_OPTIONS,
  RATING_MAX,
  RATING_MIN,
  dayOf,
  noonOf,
  numberRange,
  type AttributeDef,
  type AttributeType,
} from '../../types/attributes.js';

export abstract class AttributeDefinition {
  readonly #data: Readonly<AttributeDef>;

  protected constructor(data: AttributeDef) {
    this.#data = Object.freeze(structuredClone(data));
  }

  /** The class of the stored definition's type. */
  static of(data: AttributeDef): AttributeDefinition {
    switch (data.type) {
      case 'rating':
        return new RatingAttribute(data);
      case 'number':
        return new NumberAttribute(data);
      case 'select':
        return new SelectAttribute(data);
      case 'multiSelect':
        return new MultiSelectAttribute(data);
      case 'text':
        return new TextAttribute(data);
      case 'date':
        return new DateAttribute(data);
      case 'checkbox':
        return new CheckboxAttribute(data);
    }
  }

  get key(): string {
    return this.#data.key;
  }

  get name(): string {
    return this.#data.name;
  }

  abstract readonly type: AttributeType;

  get builtIn(): boolean {
    return this.#data.builtIn;
  }

  /** The allowed values of a select. */
  protected get options(): readonly string[] {
    return this.#data.options ?? [];
  }

  /** Why a value (never null) does not fit this type, or null when it does. */
  protected abstract valueError(value: unknown): string | null;

  /** A reason a value does not fit the definition, or null when it does. */
  check(value: unknown): string | null {
    return value === null ? null : this.valueError(value);
  }

  /** The value as the overlay stores it (a date becomes a Date; the rest as it is). */
  store(value: unknown): unknown {
    return value;
  }

  toJSON(): AttributeDef {
    return structuredClone(this.#data);
  }

  protected get definition(): AttributeDef {
    return this.#data;
  }
}

class RatingAttribute extends AttributeDefinition {
  readonly type = 'rating' as const;

  protected valueError(value: unknown): string | null {
    return Number.isInteger(value) &&
      (value as number) >= RATING_MIN &&
      (value as number) <= RATING_MAX
      ? null
      : `${this.key} is a rating from ${String(RATING_MIN)} to ${String(RATING_MAX)}`;
  }
}

class NumberAttribute extends AttributeDefinition {
  readonly type = 'number' as const;

  get range(): { min: number; max: number } {
    return numberRange(this.definition);
  }

  protected valueError(value: unknown): string | null {
    return typeof value === 'number' && Number.isFinite(value) ? null : `${this.key} is a number`;
  }
}

class TextAttribute extends AttributeDefinition {
  readonly type = 'text' as const;

  protected valueError(value: unknown): string | null {
    return typeof value === 'string' && value.length <= ATTRIBUTE_TEXT_MAX
      ? null
      : `${this.key} is text of at most ${String(ATTRIBUTE_TEXT_MAX)} characters`;
  }
}

class CheckboxAttribute extends AttributeDefinition {
  readonly type = 'checkbox' as const;

  protected valueError(value: unknown): string | null {
    return typeof value === 'boolean' ? null : `${this.key} is true or false`;
  }
}

/** A date is a day, stored at noon UTC, as a Date (it filters and sorts as one). */
class DateAttribute extends AttributeDefinition {
  readonly type = 'date' as const;

  protected valueError(value: unknown): string | null {
    return typeof value === 'string' && dayOf(value) !== null
      ? null
      : `${this.key} is a date (YYYY-MM-DD or an ISO date-time)`;
  }

  override store(value: unknown): unknown {
    if (typeof value !== 'string') return value;
    const day = dayOf(value);
    return day === null ? value : noonOf(day);
  }
}

class SelectAttribute extends AttributeDefinition {
  readonly type = 'select' as const;

  protected valueError(value: unknown): string | null {
    return typeof value === 'string' && this.options.includes(value)
      ? null
      : `${this.key} is one of its options`;
  }
}

class MultiSelectAttribute extends AttributeDefinition {
  readonly type = 'multiSelect' as const;

  protected valueError(value: unknown): string | null {
    return Array.isArray(value) &&
      value.length <= MAX_ATTRIBUTE_OPTIONS &&
      value.every((entry) => typeof entry === 'string' && this.options.includes(entry))
      ? null
      : `${this.key} is a list of its options`;
  }
}
