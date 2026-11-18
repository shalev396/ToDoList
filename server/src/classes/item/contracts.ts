/**
 * What items can do (`implements`), so code asks for "something completable" or "something
 * scheduled" instead of a concrete class, and the compiler holds every implementing class to the
 * whole contract (docs/design/CLASSES.md §4).
 */
import type { Caller } from '../base/Caller.js';
import type { CreateCopyOutcome, CreateCopyRequestBody } from '../../types/providerCreate.js';
import type { Provider } from '../../types/domain.js';
import type { DueDate } from './DueDate.js';
import type { Item } from './Item.js';
import type { ItemEdit } from './ItemEdit.js';
import type { TimeRange } from './TimeRange.js';

/** An item whose own fields are edited here (a local to-do: every field is TodoList's). */
export interface Editable<TSelf> {
  update(caller: Caller, edit: ItemEdit): Promise<TSelf>;
}

/**
 * Can be marked done, and open again: a to-do. Scheduled time (a time block, an area, a travel
 * leg) never is: ScheduledItem does not implement it, so the compiler refuses to complete one.
 */
export interface Completable<TSelf> {
  complete(caller: Caller, done: boolean): Promise<TSelf>;
}

/** Can be deleted here (a soft delete; the purge removes it later). */
export interface Deletable {
  delete(caller: Caller): Promise<void>;
}

/** Has a due date (null: none): the instant, and whether it has no time of day. */
export interface HasDueDate {
  readonly due: DueDate | null;
}

/** Can be copied into one of its owner's providers (H5: "Also create in"). */
export interface Copyable {
  copyTo(caller: Caller, request: CreateCopyRequestBody): Promise<CreateCopyOutcome>;
}

/** Mirrored from a provider: where to open it there. */
export interface ProviderLinked {
  readonly integrationId: string;
  readonly openIn: { readonly provider: Provider; readonly url: string };
}

/** Has a time span (an event, a time block): its start, its end and whether it is all day. */
export interface Schedulable {
  readonly timeRange: TimeRange | null;
}

/**
 * May repeat: one record whose rule (RRULE lines, as Google keeps them) makes its occurrences (a
 * Google series' master, a repeating time block).
 */
export interface Recurring {
  readonly isRecurring: boolean;
  /** Its rule's lines; empty when it doesn't repeat. */
  readonly recurrenceLines: readonly string[];
}

/**
 * A budget of actions in a window: reserved before the action (false: none left), given back
 * only for a definite "no" (an action that may have happened keeps its place).
 */
export interface RateLimiter {
  reserve(): Promise<boolean>;
  release(): Promise<void>;
}

/** True when the item can be completed (a to-do; never scheduled time or a mirrored item). */
export function isCompletable(item: Item): item is Item & Completable<Item> {
  return typeof (item as Partial<Completable<Item>>).complete === 'function';
}

/** True when the item can be deleted here (a to-do, a time block; never a travel leg). */
export function isDeletable(item: Item): item is Item & Deletable {
  return typeof (item as Partial<Deletable>).delete === 'function';
}
