/**
 * One edit of a mirrored item's provider fields (plan Addendum A1), validated: a value object
 * (immutable, compared by value). It names only the item fields a provider may hold: title,
 * status, due date (with `allDay`), start and priority. TodoList's own fields (note, pin, hidden,
 * topic, custom attributes, `calendarSync`, and Phase 4's planned date and local overrides) are
 * not part of it: they go through the item's overlay path, under the item policy.
 *
 * `against(item, writable)` compares it with one item:
 * - a field set to what the item already has is dropped (it is no write, and no write gate);
 * - a changed field the provider doesn't take for the item's kind is refused before anything is
 *   opened (FieldNotWritableError, 422 `field_not_writable`);
 * - the rest is what the provider is sent. Nothing changed: null.
 * Pure: no database, no provider.
 */
import { z } from 'zod';

import { FieldNotWritableError } from '../../errors/FieldNotWritableError.js';
import type { ItemData } from '../../models/definitions/Item.js';
import { TITLE_MAX } from './createFields.js';
import { ITEM_STATUSES, type ItemStatus } from '../../types/domain.js';
import type { WritableField } from '../../types/integrations.js';
import { parseOr400 } from '../../utils/validation.js';
import type { DueChange, ProviderPatch } from './writeBack.js';

/** An edit as callers give it: every field optional, at least one. */
export interface TaskPatch {
  title?: string;
  status?: ItemStatus;
  /** null clears it. */
  dueAt?: Date | null;
  /** The due date has no time of day (only with `dueAt`; default: as the item is now). */
  allDay?: boolean;
  /** null clears it. */
  startAt?: Date | null;
  /** 0 (lowest) … 4 (highest); null: none. */
  priority?: number | null;
}

/** A changed set of provider fields for one item: what is sent, and the names of what changes. */
export interface ProviderEdit {
  readonly patch: ProviderPatch;
  readonly fields: readonly WritableField[];
}

/** A control character (below U+0020, or DEL) anywhere in the text. */
export const hasControlCharacter = (text: string): boolean =>
  Array.from(text).some((char) => {
    const code = char.codePointAt(0) ?? 0;
    return code < 32 || code === 127;
  });

/** A title as a write-back sends it: one line, trimmed, 1–255 characters. */
export const OneLineTitle = z
  .string()
  .trim()
  .min(1)
  .max(TITLE_MAX)
  .refine((title) => !hasControlCharacter(title), 'Must be one line of text');

const Instant = z.date().refine((date) => !Number.isNaN(date.getTime()), 'Must be a valid date');

const Patch = z
  .strictObject({
    title: OneLineTitle.optional(),
    status: z.enum(ITEM_STATUSES).optional(),
    dueAt: Instant.nullable().optional(),
    allDay: z.boolean().optional(),
    startAt: Instant.nullable().optional(),
    priority: z.int().min(0).max(4).nullable().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one change is required')
  .refine((patch) => patch.allDay === undefined || (patch.dueAt ?? null) !== null, {
    message: 'Only with a due date',
    path: ['allDay'],
  });

type ParsedPatch = z.output<typeof Patch>;

const sameInstant = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

export class TaskEdit {
  readonly #patch: Readonly<ParsedPatch>;

  private constructor(patch: ParsedPatch) {
    this.#patch = Object.freeze({ ...patch });
    Object.freeze(this);
  }

  /** The edit, validated (400 naming the field: an unknown one, an empty edit, a wrong type). */
  static parse(patch: unknown): TaskEdit {
    return new TaskEdit(parseOr400(Patch, patch));
  }

  /** The fields it names (changed or not). */
  get fields(): readonly WritableField[] {
    const fields: WritableField[] = [];
    if (this.#patch.title !== undefined) fields.push('title');
    if (this.#patch.status !== undefined) fields.push('status');
    if (this.#patch.dueAt !== undefined) fields.push('dueAt');
    if (this.#patch.startAt !== undefined) fields.push('startAt');
    if (this.#patch.priority !== undefined) fields.push('priority');
    return fields;
  }

  /**
   * The edit for `item`, whose provider takes `writable` for its kind: the changed fields, or null
   * when nothing changes. A changed field the provider doesn't take: FieldNotWritableError.
   */
  against(
    item: ItemData,
    writable: readonly WritableField[],
    timeZone: string,
  ): ProviderEdit | null {
    const patch = this.#patch;
    const sent: { -readonly [K in keyof ProviderPatch]: ProviderPatch[K] } = { timeZone };
    const changed: WritableField[] = [];
    if (patch.title !== undefined && patch.title !== item.title) {
      sent.title = patch.title;
      changed.push('title');
    }
    if (patch.status !== undefined && patch.status !== item.status) {
      sent.status = patch.status;
      changed.push('status');
    }
    if (patch.dueAt !== undefined) {
      const due: DueChange | null =
        patch.dueAt === null ? null : { at: patch.dueAt, allDay: patch.allDay ?? item.allDay };
      const unchanged =
        due === null
          ? item.dueAt === null
          : sameInstant(due.at, item.dueAt) && due.allDay === item.allDay;
      if (!unchanged) {
        sent.due = due;
        changed.push('dueAt');
      }
    }
    if (patch.startAt !== undefined && !sameInstant(patch.startAt, item.startAt)) {
      sent.startAt = patch.startAt;
      changed.push('startAt');
    }
    if (patch.priority !== undefined && patch.priority !== item.priority) {
      sent.priority = patch.priority;
      changed.push('priority');
    }
    const refused = changed.filter((field) => !writable.includes(field));
    if (refused.length > 0) {
      const { provider, url } = item.source;
      throw new FieldNotWritableError(provider, refused, { provider, url });
    }
    if (changed.length === 0) return null;
    return Object.freeze({ patch: Object.freeze(sent), fields: Object.freeze(changed) });
  }

  /** The same edit (by value). */
  equals(other: TaskEdit): boolean {
    return JSON.stringify(this.#patch) === JSON.stringify(other.#patch);
  }
}
