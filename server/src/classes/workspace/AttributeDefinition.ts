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
  type AttributePatch,
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
      default:
        // A stored type this code does not know: only its own values fail, never the workspace.
        return new UnknownAttribute(data);
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

  /**
   * Why a patch's shape does not fit this type (options of a select, the range of a number), or
   * null when it does. A patch that changes neither is always fine.
   */
  patchError(patch: AttributePatch): string | null {
    if (
      patch.options === undefined &&
      patch.min === undefined &&
      patch.max === undefined &&
      patch.optionLooks === undefined &&
      patch.renames === undefined
    ) {
      return null;
    }
    if (!this.takesLooks && (patch.optionLooks !== undefined || patch.renames !== undefined)) {
      return 'Only a select has looks and renames';
    }
    return this.shapeError(patch);
  }

  /** Whether the type has option looks and renames (a select does). */
  protected readonly takesLooks: boolean = false;

  /**
   * The definition after a patch: what the patch names replaces what was stored (options without
   * duplicates). `renames` are an instruction for the stored values, never part of a definition.
   */
  merge(patch: AttributePatch): AttributeDef {
    return {
      ...this.#data,
      ...(patch.name === undefined ? {} : { name: patch.name }),
      ...(patch.options === undefined ? {} : { options: [...new Set(patch.options)] }),
      ...(patch.min === undefined ? {} : { min: patch.min }),
      ...(patch.max === undefined ? {} : { max: patch.max }),
    };
  }

  /** The type's rule for a patch that names options or a range: by default it takes neither. */
  protected shapeError(patch: AttributePatch): string | null {
    if (patch.options !== undefined) return 'Only a select has options';
    if (patch.min !== undefined || patch.max !== undefined) return 'Only a number has a range';
    return null;
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

  protected override shapeError(patch: AttributePatch): string | null {
    if (patch.options !== undefined) return 'Only a select has options';
    const { min, max } = numberRange({
      ...this.definition,
      ...(patch.min === undefined ? {} : { min: patch.min }),
      ...(patch.max === undefined ? {} : { max: patch.max }),
    });
    return max <= min ? 'max must be above min' : null;
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

  protected override readonly takesLooks: boolean = true;

  /** Looks follow their option through a rename and go with an option the patch drops. */
  override merge(patch: AttributePatch): AttributeDef {
    const merged = super.merge(patch);
    const options = merged.options ?? [];
    const stored = this.definition.optionLooks;
    if (patch.optionLooks === undefined && stored === undefined) return merged;
    const renamed = new Map((patch.renames ?? []).map(({ from, to }) => [from, to]));
    const optionLooks =
      patch.optionLooks ??
      (stored ?? [])
        .map((look) => ({ ...look, option: renamed.get(look.option) ?? look.option }))
        .filter((look) => options.includes(look.option));
    return { ...merged, optionLooks };
  }

  protected override shapeError(patch: AttributePatch): string | null {
    if (patch.min !== undefined || patch.max !== undefined) return 'Only a number has a range';
    if (patch.options?.length === 0) return 'A select needs options';
    const options = this.merge(patch).options ?? [];
    const renames = patch.renames ?? [];
    const froms = new Set(renames.map((rename) => rename.from));
    const tos = new Set(renames.map((rename) => rename.to));
    if (froms.size !== renames.length || tos.size !== renames.length) {
      return 'Each option is renamed at most once';
    }
    for (const { from, to } of renames) {
      if (!this.options.includes(from) || options.includes(from)) {
        return 'A rename names an option that was removed';
      }
      if (this.options.includes(to) || !options.includes(to)) {
        return 'A rename names a new option';
      }
    }
    const seen = new Set<string>();
    for (const look of this.merge(patch).optionLooks ?? []) {
      if (!options.includes(look.option)) return 'A look names an option';
      if (seen.has(look.option)) return 'One look per option';
      seen.add(look.option);
    }
    return null;
  }

  protected valueError(value: unknown): string | null {
    return typeof value === 'string' && this.options.includes(value)
      ? null
      : `${this.key} is one of its options`;
  }
}

class MultiSelectAttribute extends AttributeDefinition {
  readonly type = 'multiSelect' as const;

  protected override shapeError(patch: AttributePatch): string | null {
    if (patch.min !== undefined || patch.max !== undefined) return 'Only a number has a range';
    return patch.options?.length === 0 ? 'A select needs options' : null;
  }

  protected valueError(value: unknown): string | null {
    return Array.isArray(value) &&
      value.length <= MAX_ATTRIBUTE_OPTIONS &&
      value.every((entry) => typeof entry === 'string' && this.options.includes(entry))
      ? null
      : `${this.key} is a list of its options`;
  }
}

/** A stored definition of a type this code does not know: it fits no value, and nothing else. */
class UnknownAttribute extends AttributeDefinition {
  readonly type: AttributeType;

  constructor(data: AttributeDef) {
    super(data);
    this.type = data.type;
  }

  protected valueError(): string | null {
    return `${this.key} has a type this server does not know`;
  }
}
