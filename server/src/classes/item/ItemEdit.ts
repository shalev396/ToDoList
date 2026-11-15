/**
 * One edit of an item (`PATCH …/items/:id`, MCP `update_todo`), as an immutable value object, in
 * the item's own names, dates already `Date`s (the route converts). Who applies it depends on the
 * item (Item#edit, polymorphic):
 * - a local to-do changes its own fields (`localPatch`);
 * - a mirrored item splits it (`split`): the fields its provider takes for its kind go to the
 *   provider (the provider half), the fields its provider lacks are kept here as overrides (the
 *   local half), and anything else is edited at its source (`refused`: today's 409 with `openIn`).
 * Pure.
 */
import { ValidationError } from '../../errors/ValidationError.js';
import type { LocalItemPatch } from '../../models/definitions/Item.js';
import type { ItemStatus } from '../../types/domain.js';
import type { WritableField } from '../../types/integrations.js';
import { OVERRIDABLE_FIELDS, type OverridableField } from '../../types/items.js';
import type { OverridesPatch } from './Overrides.js';

/** An edit as callers give it: every field optional (an absent one does not change). */
export interface ItemEditInput {
  /** null clears an override of it (a mirrored item whose provider lacks it); else 400. */
  title?: string | null;
  /** A to-do's note (its preview text); null clears it. */
  note?: string | null;
  /** null clears it. */
  dueAt?: Date | null;
  /** With `dueAt`, or (an event) with its time: it has no time of day. */
  allDay?: boolean;
  startAt?: Date | null;
  endAt?: Date | null;
  /** A topic of the workspace; null = Unsorted. */
  topicId?: string | null;
  containerId?: string | null;
  priority?: number | null;
  /** null clears an override of it (a mirrored item whose provider lacks it); else 400. */
  status?: ItemStatus | null;
  /** A calendar event with other guests: whether Google tells them (not a field). */
  notifyGuests?: boolean;
}

/** Optional keys may be present as undefined (zod output). */
export type LooseItemEditInput = { [K in keyof ItemEditInput]?: ItemEditInput[K] | undefined };

/** A field an edit may name. */
export type EditField = Exclude<keyof ItemEditInput, 'notifyGuests'>;

const EDIT_FIELDS: readonly EditField[] = [
  'title',
  'note',
  'dueAt',
  'allDay',
  'startAt',
  'endAt',
  'topicId',
  'containerId',
  'priority',
  'status',
];

/** The item fields a provider may hold (WritableField), in an edit's names. */
const PROVIDER_CANDIDATES = ['title', 'status', 'dueAt', 'startAt', 'endAt', 'priority'] as const;

/** What goes to the provider: the provider fields named, as given. */
export interface ProviderHalf {
  readonly title?: string;
  readonly status?: ItemStatus;
  readonly dueAt?: Date | null;
  readonly allDay?: boolean;
  readonly startAt?: Date | null;
  readonly endAt?: Date | null;
  readonly priority?: number | null;
}

/** One edit, split for a mirrored item. */
export interface EditSplit {
  /** For the provider (empty: nothing for it). */
  readonly provider: ProviderHalf;
  /** For the overrides, as given (the item drops one equal to the provider's value). */
  readonly overrides: OverridesPatch;
  /** Fields edited at the item's source only (any: the whole edit is refused with 409). */
  readonly refused: readonly EditField[];
}

function closedAtFor(status: ItemStatus, now: Date): Date | null {
  return status === 'done' || status === 'cancelled' ? now : null;
}

export class ItemEdit {
  readonly #input: Readonly<ItemEditInput>;

  private constructor(input: ItemEditInput) {
    this.#input = Object.freeze({ ...input });
    Object.freeze(this);
  }

  /** The edit, without the absent keys; at least one change (400 otherwise). */
  static of(input: LooseItemEditInput): ItemEdit {
    const kept = Object.fromEntries(
      Object.entries(input).filter(([, value]) => value !== undefined),
    ) as ItemEditInput;
    if (EDIT_FIELDS.every((field) => kept[field] === undefined)) {
      throw new ValidationError('At least one change is required');
    }
    return new ItemEdit(kept);
  }

  /** The fields it names. */
  get fields(): EditField[] {
    return EDIT_FIELDS.filter((field) => this.#input[field] !== undefined);
  }

  /** Whether it names `field`. */
  has(field: EditField): boolean {
    return this.#input[field] !== undefined;
  }

  get<K extends keyof ItemEditInput>(field: K): ItemEditInput[K] {
    return this.#input[field];
  }

  get notifyGuests(): boolean | undefined {
    return this.#input.notifyGuests;
  }

  /** A to-do's own fields: the edit as stored (`closedAt` follows a status change). */
  localPatch(now: Date = new Date()): LocalItemPatch {
    const input = this.#input;
    for (const field of ['title', 'status'] as const) {
      if (input[field] === null)
        throw new ValidationError(`${field}: a to-do's ${field} can't be cleared`);
    }
    return {
      ...(input.title === undefined || input.title === null ? {} : { title: input.title }),
      ...(input.note === undefined ? {} : { bodyPreview: input.note }),
      ...(input.dueAt === undefined ? {} : { dueAt: input.dueAt }),
      ...(input.allDay === undefined ? {} : { allDay: input.allDay }),
      ...(input.startAt === undefined ? {} : { startAt: input.startAt }),
      ...(input.endAt === undefined ? {} : { endAt: input.endAt }),
      ...(input.topicId === undefined ? {} : { topicId: input.topicId }),
      ...(input.containerId === undefined ? {} : { containerId: input.containerId }),
      ...(input.priority === undefined ? {} : { priority: input.priority }),
      ...(input.status === undefined || input.status === null
        ? {}
        : { status: input.status, closedAt: closedAtFor(input.status, now) }),
    };
  }

  /**
   * The split for a mirrored item whose provider takes `writable` for its kind: each field the
   * provider takes goes to it; each other overridable field (title, status, due date, start,
   * priority) becomes an override; anything else is refused. `allDay` follows the due date (to
   * whichever half takes it), or an event's time; alone it is a 400.
   */
  split(writable: readonly WritableField[]): EditSplit {
    const input = this.#input;
    const provider: { -readonly [K in keyof ProviderHalf]: ProviderHalf[K] } = {};
    const overrides: { -readonly [K in keyof OverridesPatch]: OverridesPatch[K] } = {};
    const refused: EditField[] = [];
    for (const field of PROVIDER_CANDIDATES) {
      if (input[field] === undefined) continue;
      if (writable.includes(field)) {
        if (input[field] === null && (field === 'title' || field === 'status')) {
          throw new ValidationError(`${field}: a provider field can't be cleared`);
        }
        Object.assign(provider, { [field]: input[field] });
      } else if ((OVERRIDABLE_FIELDS as readonly string[]).includes(field)) {
        Object.assign(overrides, { [field as OverridableField]: input[field] });
      } else {
        refused.push(field);
      }
    }
    if (input.allDay !== undefined) {
      if (input.dueAt !== undefined) {
        if (writable.includes('dueAt')) provider.allDay = input.allDay;
        else overrides.allDay = input.dueAt === null ? null : input.allDay;
      } else if (provider.startAt !== undefined || provider.endAt !== undefined) {
        provider.allDay = input.allDay;
      } else {
        throw new ValidationError('allDay: only with dueAt, or with startAt and endAt');
      }
    } else if (overrides.dueAt !== undefined) {
      // A due date kept here keeps no time-of-day flag unless one is given.
      overrides.allDay = null;
    }
    for (const field of ['note', 'topicId', 'containerId'] as const) {
      if (input[field] !== undefined) refused.push(field);
    }
    return Object.freeze({
      provider: Object.freeze(provider),
      overrides: Object.freeze(overrides),
      refused: Object.freeze(refused),
    });
  }

  /** The same edit (by value). */
  equals(other: ItemEdit): boolean {
    return JSON.stringify(this.#input) === JSON.stringify(other.#input);
  }
}
