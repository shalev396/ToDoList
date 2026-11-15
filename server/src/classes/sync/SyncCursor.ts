/**
 * Where one integration's sync of one resource stands (DATA.md §3.8, a SyncStates row), as a value
 * object: its cursor, sync token and etag, when it last listed in full or incrementally, and the
 * failed runs in a row (on the `__run__` pseudo-resource). Immutable; equal by value. `none` is a
 * resource never synced.
 *
 * Adapters read the stored state as it is (`toState()`: the row, or null), so their contract is
 * unchanged.
 */
import type { SyncStateData } from '../../models/definitions/SyncState.js';

const copyOf = (date: Date | null): Date | null => (date === null ? null : new Date(date));

export class SyncCursor {
  /** A resource never synced. */
  static readonly none = new SyncCursor(null);

  readonly #state: Readonly<SyncStateData> | null;

  private constructor(state: SyncStateData | null) {
    // A deep copy (its dates too), so neither the row it came from nor a getter's caller changes it.
    this.#state = state === null ? null : Object.freeze(structuredClone(state));
    Object.freeze(this);
  }

  /** The cursor of a stored state (none for null). */
  static of(state: SyncStateData | null): SyncCursor {
    return state === null ? SyncCursor.none : new SyncCursor(state);
  }

  /** Whether the resource was ever synced (a state is stored). */
  get exists(): boolean {
    return this.#state !== null;
  }

  get cursor(): string | null {
    return this.#state?.cursor ?? null;
  }

  get syncToken(): string | null {
    return this.#state?.syncToken ?? null;
  }

  get etag(): string | null {
    return this.#state?.etag ?? null;
  }

  /** A copy: the cursor's own dates never leave it. */
  get updatedSince(): Date | null {
    return copyOf(this.#state?.updatedSince ?? null);
  }

  /** A copy. */
  get lastFullSyncAt(): Date | null {
    return copyOf(this.#state?.lastFullSyncAt ?? null);
  }

  /** A copy. */
  get lastIncrementalAt(): Date | null {
    return copyOf(this.#state?.lastIncrementalAt ?? null);
  }

  get consecutiveErrors(): number {
    return this.#state?.consecutiveErrors ?? 0;
  }

  /** Whether the last complete full listing is at least `intervalMs` old (or never happened). */
  isFullSyncDue(now: Date, intervalMs: number): boolean {
    const last = this.lastFullSyncAt;
    return last === null || now.getTime() - last.getTime() >= intervalMs;
  }

  /** The stored state as adapters read it (a deep copy): the row, or null for one never synced. */
  toState(): SyncStateData | null {
    return this.#state === null ? null : structuredClone(this.#state);
  }

  /** Same position: the same token, cursor, etag, window and counters. */
  equals(other: SyncCursor | null | undefined): boolean {
    if (other === null || other === undefined) return false;
    const time = (date: Date | null): number | null => date?.getTime() ?? null;
    return (
      this.exists === other.exists &&
      this.cursor === other.cursor &&
      this.syncToken === other.syncToken &&
      this.etag === other.etag &&
      time(this.updatedSince) === time(other.updatedSince) &&
      time(this.lastFullSyncAt) === time(other.lastFullSyncAt) &&
      time(this.lastIncrementalAt) === time(other.lastIncrementalAt) &&
      this.consecutiveErrors === other.consecutiveErrors
    );
  }
}
