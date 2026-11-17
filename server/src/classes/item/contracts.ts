/**
 * What items can do (`implements`), so code asks for "something completable" or "something
 * scheduled" instead of a concrete class, and the compiler holds every implementing class to the
 * whole contract (docs/design/CLASSES.md §4).
 */
import type { Caller } from '../base/Caller.js';
import type { CreateCopyOutcome, CreateCopyRequestBody } from '../../types/providerCreate.js';
import type { Provider } from '../../types/domain.js';
import type { DueDate } from './DueDate.js';
import type { ItemEdit } from './ItemEdit.js';
import type { TimeRange } from './TimeRange.js';

/** An item whose own fields are edited here (a local to-do: every field is TodoList's). */
export interface Editable<TSelf> {
  update(caller: Caller, edit: ItemEdit): Promise<TSelf>;
}

/** Can be marked done, and open again. */
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

/** Has a time span (a calendar event): its start, its end and whether it is all day. */
export interface Schedulable {
  readonly timeRange: TimeRange | null;
}

/**
 * A budget of actions in a window: reserved before the action (false: none left), given back
 * only for a definite "no" (an action that may have happened keeps its place).
 */
export interface RateLimiter {
  reserve(): Promise<boolean>;
  release(): Promise<void>;
}
