/**
 * A mirrored item's overrides (Phase 4a), as an immutable value object: values kept in TodoList
 * for the fields its provider lacks for the item's kind (GitHub's due date, start date and
 * priority; Jira's and Linear's start date; anything of a pull request). The sync never touches
 * them, and a local to-do has none (it edits its own fields).
 *
 * What an item reads as is its EFFECTIVE value, `override ?? source`, on every read path: the item
 * views, MCP's summaries, the query builder's filters, sorts and groups, the facets and the
 * workspace calendar's push. In memory that is `effective()`; in an aggregation it is
 * `Overrides.projection()`, an `$addFields` stage that replaces each field with its effective value
 * right after the access filter's `$match` (which always stays first), so everything after it reads
 * the effective values. The rule is idempotent: applying it to effective values changes nothing.
 *
 * Pure: no database, no request state (the query builder's compiler loads it).
 */
import type { ItemOverrides } from '../../models/definitions/Item.js';
import type { ItemStatus } from '../../types/domain.js';
import {
  OVERRIDABLE_FIELDS,
  type ItemOverridesView,
  type OverridableField,
} from '../../types/items.js';
import { redactString } from '../../services/secretPatterns.js';

export { OVERRIDABLE_FIELDS, type OverridableField };

/** The source values an override may stand in for. */
export interface OverridableValues {
  readonly title: string;
  readonly status: ItemStatus;
  readonly dueAt: Date | null;
  readonly allDay: boolean;
  readonly startAt: Date | null;
  readonly priority: number | null;
}

/** An override set or cleared (null) by one edit. */
export type OverridesPatch = Partial<ItemOverrides>;

const NONE: ItemOverrides = Object.freeze({
  title: null,
  status: null,
  dueAt: null,
  allDay: null,
  startAt: null,
  priority: null,
});

/** `$ifNull` of an override and its field: the effective value in an aggregation. */
function effectiveOf(field: keyof ItemOverrides): Record<string, unknown> {
  return { $ifNull: [`$overlay.overrides.${field}`, `$${field}`] };
}

export class Overrides {
  readonly #values: Readonly<ItemOverrides>;

  private constructor(values: ItemOverrides) {
    this.#values = Object.freeze({ ...values });
    Object.freeze(this);
  }

  /** No override. */
  static none(): Overrides {
    return new Overrides(NONE);
  }

  /** As stored (absent on items stored before Phase 4a: none). */
  static from(stored: Partial<ItemOverrides> | null | undefined): Overrides {
    return new Overrides({
      title: typeof stored?.title === 'string' ? stored.title : null,
      status: typeof stored?.status === 'string' ? stored.status : null,
      dueAt: stored?.dueAt instanceof Date ? stored.dueAt : null,
      allDay: typeof stored?.allDay === 'boolean' ? stored.allDay : null,
      startAt: stored?.startAt instanceof Date ? stored.startAt : null,
      priority: typeof stored?.priority === 'number' ? stored.priority : null,
    });
  }

  /**
   * The `$addFields` body that makes every overridable field read as its effective value
   * (`allDay` follows a due-date override). Placed right after the access filter's `$match`.
   */
  static projection(): Record<string, unknown> {
    return {
      title: effectiveOf('title'),
      status: effectiveOf('status'),
      dueAt: effectiveOf('dueAt'),
      allDay: effectiveOf('allDay'),
      startAt: effectiveOf('startAt'),
      priority: effectiveOf('priority'),
    };
  }

  /**
   * The patch that clears the overrides of `fields` (a write-back of those fields at the
   * provider: the provider's value is what the item reads as from then on). Clearing `dueAt`
   * clears its `allDay` too.
   */
  static clearing(fields: readonly string[]): OverridesPatch {
    const patch: { -readonly [K in keyof ItemOverrides]?: ItemOverrides[K] } = {};
    for (const field of OVERRIDABLE_FIELDS) {
      if (fields.includes(field)) patch[field] = null;
    }
    if (patch.dueAt === null) patch.allDay = null;
    return patch;
  }

  /** The override of `field` (null: none). */
  get<K extends keyof ItemOverrides>(field: K): ItemOverrides[K] {
    return this.#values[field];
  }

  /** Whether any override is set. */
  get isEmpty(): boolean {
    return Object.values(this.#values).every((value) => value === null);
  }

  /** The fields that carry an override. */
  get fields(): OverridableField[] {
    return OVERRIDABLE_FIELDS.filter((field) => this.#values[field] !== null);
  }

  /** What the item reads as: each override where set, else the source value. */
  effective(source: OverridableValues): OverridableValues {
    const values = this.#values;
    return {
      title: values.title ?? source.title,
      status: values.status ?? source.status,
      dueAt: values.dueAt ?? source.dueAt,
      allDay: values.allDay ?? source.allDay,
      startAt: values.startAt ?? source.startAt,
      priority: values.priority ?? source.priority,
    };
  }

  /** Same overrides (by value). */
  equals(other: Overrides): boolean {
    return (Object.keys(NONE) as (keyof ItemOverrides)[]).every((field) => {
      const mine = this.#values[field];
      const theirs = other.#values[field];
      return mine instanceof Date && theirs instanceof Date
        ? mine.getTime() === theirs.getTime()
        : mine === theirs;
    });
  }

  /** As the API shows them (text redacted). */
  toView(): ItemOverridesView {
    const values = this.#values;
    return { ...values, title: values.title === null ? null : redactString(values.title) };
  }

  /** A plain copy, as stored. */
  toJSON(): ItemOverrides {
    return { ...this.#values };
  }
}
