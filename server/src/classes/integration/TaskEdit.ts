/**
 * One edit of a mirrored item (plan Addendum A1), validated: a value object (immutable, compared
 * by value). It holds two kinds of field:
 * - the item's own fields a provider may hold too: title, status, due date (with `allDay`), start
 *   and priority;
 * - TodoList's own (the overlay): note, pin, hidden, topic override, custom attributes.
 *
 * `split` sorts them for one item: the fields its provider takes (its definition's
 * `writableFields`, for the item's kind) and that change become the provider patch, written there
 * first; everything else (TodoList's own fields, and the item fields the provider lacks) stays
 * here. Pure: no database, no provider.
 */
import { z } from 'zod';

import type { ItemData, ItemOverlay, MirroredItemPatch } from '../../models/definitions/Item.js';
import { AttrValues } from '../../services/itemSchemas.js';
import { TITLE_MAX } from '../../services/providerCreate/fields.js';
import { ITEM_STATUSES, type ItemStatus } from '../../types/domain.js';
import type { WritableField } from '../../types/integrations.js';
import { parseOr400 } from '../../utils/validation.js';
import type { DueChange, UpdateFields } from './writers/trackerWriter.js';

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
  note?: string | null;
  pinned?: boolean | null;
  hidden?: boolean | null;
  /** A topic of the workspace; null: the item's own. */
  topicOverride?: string | null;
  /** Custom attribute values by key; null clears one (types/attributes.ts). */
  attrs?: Record<string, unknown>;
}

/** The item fields a provider may hold, as a patch names them. */
const TASK_FIELDS = ['title', 'status', 'dueAt', 'startAt', 'priority'] as const;
type TaskField = (typeof TASK_FIELDS)[number];

const Instant = z.date().refine((date) => !Number.isNaN(date.getTime()), 'Must be a valid date');

const Patch = z
  .strictObject({
    title: z.string().trim().min(1).max(TITLE_MAX).optional(),
    status: z.enum(ITEM_STATUSES).optional(),
    dueAt: Instant.nullable().optional(),
    allDay: z.boolean().optional(),
    startAt: Instant.nullable().optional(),
    priority: z.int().min(0).max(4).nullable().optional(),
    note: z.string().max(5000).nullable().optional(),
    pinned: z.boolean().nullable().optional(),
    hidden: z.boolean().nullable().optional(),
    topicOverride: z.string().min(1).max(100).nullable().optional(),
    attrs: AttrValues.optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one change is required')
  .refine((patch) => patch.allDay === undefined || (patch.dueAt ?? null) !== null, {
    message: 'Only with a due date',
    path: ['allDay'],
  });

/** What a provider is sent: the changed fields it takes, and the status it is asked for. */
export interface ProviderPatch extends UpdateFields {
  readonly status?: ItemStatus;
}

/**
 * What stays in TodoList: item fields the provider lacks, and TodoList's own fields (the custom
 * attribute values travel apart: `attrs`, checked against the workspace first).
 */
export interface LocalChanges {
  readonly columns: Readonly<MirroredItemPatch>;
  readonly overlay: Readonly<Partial<Omit<ItemOverlay, 'attrs'>>>;
}

/** One edit, split for one item: what its provider is sent, and what stays here. */
export interface SplitEdit {
  /** Null: nothing for the provider (no write session is opened). */
  readonly provider: ProviderPatch | null;
  /** The provider fields being sent, by name (the audit's `fields`). */
  readonly providerFields: readonly WritableField[];
  readonly local: LocalChanges;
}

type ParsedPatch = z.output<typeof Patch>;

const sameInstant = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

const OVERLAY_FIELDS = ['note', 'pinned', 'hidden', 'topicOverride'] as const;

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

  /** The item fields it changes that a provider may hold (before looking at any one item). */
  get taskFields(): readonly TaskField[] {
    return TASK_FIELDS.filter((field) => this.#patch[field] !== undefined);
  }

  /** Whether it changes any of `writable` (a provider's fields): then it may need a write session. */
  touches(writable: readonly WritableField[]): boolean {
    return this.taskFields.some((field) => writable.includes(field));
  }

  /** The topic it files the item under, when it names one (checked against the workspace). */
  get topicOverride(): string | null | undefined {
    return this.#patch.topicOverride;
  }

  /** The custom attribute values it sets, when any (checked against the workspace). */
  get attrs(): Readonly<Record<string, unknown>> | undefined {
    return this.#patch.attrs;
  }

  /**
   * The edit for `item`: each item field its provider takes (`writable`) and that differs from
   * the item now goes to the provider; an item field the provider lacks, and TodoList's own
   * fields, stay here. A field set to what the item already has is dropped.
   */
  split(item: ItemData, writable: readonly WritableField[], timeZone: string): SplitEdit {
    const patch = this.#patch;
    const provider: { -readonly [K in keyof ProviderPatch]: ProviderPatch[K] } = { timeZone };
    const columns: MirroredItemPatch = {};
    const sent: WritableField[] = [];
    const takes = (field: TaskField): boolean => writable.includes(field);

    if (patch.title !== undefined && patch.title !== item.title) {
      if (takes('title')) {
        provider.title = patch.title;
        sent.push('title');
      } else columns.title = patch.title;
    }
    if (patch.status !== undefined && patch.status !== item.status) {
      if (takes('status')) {
        provider.status = patch.status;
        sent.push('status');
      } else columns.status = patch.status;
    }
    if (patch.dueAt !== undefined) {
      const due: DueChange | null =
        patch.dueAt === null ? null : { at: patch.dueAt, allDay: patch.allDay ?? item.allDay };
      const unchanged =
        due === null
          ? item.dueAt === null
          : sameInstant(due.at, item.dueAt) && due.allDay === item.allDay;
      if (!unchanged) {
        if (takes('dueAt')) {
          provider.due = due;
          sent.push('dueAt');
        } else {
          columns.dueAt = due?.at ?? null;
          if (due !== null) columns.allDay = due.allDay;
        }
      }
    }
    if (patch.startAt !== undefined && !sameInstant(patch.startAt, item.startAt)) {
      if (takes('startAt')) {
        provider.startAt = patch.startAt;
        sent.push('startAt');
      } else columns.startAt = patch.startAt;
    }
    if (patch.priority !== undefined && patch.priority !== item.priority) {
      if (takes('priority')) {
        provider.priority = patch.priority;
        sent.push('priority');
      } else columns.priority = patch.priority;
    }

    const overlay: LocalChanges['overlay'] = Object.fromEntries(
      OVERLAY_FIELDS.flatMap((field) =>
        patch[field] === undefined ? [] : [[field, patch[field]]],
      ),
    );
    return Object.freeze({
      provider: sent.length === 0 ? null : Object.freeze(provider),
      providerFields: Object.freeze(sent),
      local: Object.freeze({ columns: Object.freeze(columns), overlay: Object.freeze(overlay) }),
    });
  }

  /** The same edit (by value). */
  equals(other: TaskEdit): boolean {
    return JSON.stringify(this.#patch) === JSON.stringify(other.#patch);
  }
}
