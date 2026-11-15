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
 * `allDay` is one flag of the item for its start and end and for its due date. Its override is the
 * due date's companion only, so it applies only to an item without a start (its time range keeps
 * its own form); an item with a start (an event, a task with a start date) never takes one.
 *
 * Reads stay exact and indexed: `prefilter()` turns a filter on the effective values into a wider
 * one on what is stored (each projected field: its stored value, or any override of it), which can
 * run before the projection and use the indexes; the exact filter still runs after it.
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

/** Whether a path's value in an aggregation is set (missing and null read alike). */
function isSet(path: string): Record<string, unknown> {
  return { $ne: [{ $ifNull: [path, null] }, null] };
}

/** The fields the projection rewrites: an override of any of them may change what it reads as. */
const PROJECTED: readonly (keyof ItemOverrides)[] = [
  'title',
  'status',
  'dueAt',
  'allDay',
  'startAt',
  'priority',
];

type Filter = Record<string, unknown>;

function isFilter(value: unknown): value is Filter {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Whether a filter reads a projected field anywhere. */
function readsProjected(filter: unknown): boolean {
  if (Array.isArray(filter)) return filter.some(readsProjected);
  if (!isFilter(filter)) return false;
  return Object.entries(filter).some(
    ([key, value]) =>
      (PROJECTED as readonly string[]).includes(key) ||
      (key.startsWith('$') && readsProjected(value)),
  );
}

/**
 * A filter on what is stored that every item matching `filter` (on effective values) also
 * matches; null when it narrows nothing. A leaf on a projected field becomes "that leaf on the
 * stored field, or any override of it" (without an override the two values are the same); `$and`
 * keeps what narrows; `$or` narrows only when every branch does; anything negated (`$nor`, `$not`)
 * or computed (`skip`) is left out, which only widens.
 */
function widened(filter: unknown, skip: (field: string) => boolean): Filter | null {
  if (!isFilter(filter)) return null;
  const parts: Filter[] = [];
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      for (const part of value as unknown[]) {
        const wide = widened(part, skip);
        if (wide !== null) parts.push(wide);
      }
    } else if (key === '$or' && Array.isArray(value)) {
      const branches = (value as unknown[]).map((branch) => widened(branch, skip));
      if (branches.length > 0 && branches.every((branch) => branch !== null)) {
        parts.push({ $or: branches });
      }
    } else if (key.startsWith('$') || skip(key)) {
      // Negated, computed or not a field: left out (only widens).
    } else if ((PROJECTED as readonly string[]).includes(key)) {
      parts.push({ $or: [{ [key]: value }, { [`overlay.overrides.${key}`]: { $ne: null } }] });
    } else {
      parts.push({ [key]: value });
    }
  }
  if (parts.length === 0) return null;
  return parts.length === 1 ? (parts[0] ?? null) : { $and: parts };
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
      // The due date's flag, only for an item without a start (its own, or an override).
      allDay: {
        $cond: [
          {
            $and: [
              isSet('$overlay.overrides.allDay'),
              isSet('$overlay.overrides.dueAt'),
              { $eq: [{ $ifNull: ['$overlay.overrides.startAt', '$startAt', null] }, null] },
            ],
          },
          '$overlay.overrides.allDay',
          '$allDay',
        ],
      },
      startAt: effectiveOf('startAt'),
      priority: effectiveOf('priority'),
    };
  }

  /**
   * A filter to run BEFORE the projection, on what is stored, that keeps every item `filter`
   * (run after it, on the effective values) can match: so the indexes still narrow, and the
   * answer stays exact. Null when the filter reads no projected field (MongoDB moves such a filter
   * before the projection itself) or nothing in it narrows. `skip` names computed fields (they do
   * not exist yet before the projection).
   */
  static prefilter(filter: unknown, skip: (field: string) => boolean = () => false): Filter | null {
    return readsProjected(filter) ? widened(filter, skip) : null;
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
    const startAt = values.startAt ?? source.startAt;
    return {
      title: values.title ?? source.title,
      status: values.status ?? source.status,
      dueAt: values.dueAt ?? source.dueAt,
      // The due date's flag, only for an item without a start.
      allDay:
        values.allDay !== null && values.dueAt !== null && startAt === null
          ? values.allDay
          : source.allDay,
      startAt,
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
