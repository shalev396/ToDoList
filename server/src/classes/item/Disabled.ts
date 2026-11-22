/**
 * The disabled state (the owner's ruling of 2026-11-22: "a disabled state in case a to-do is
 * cancelled, so it shows differently and I know I can set things over it"): an item, or one
 * occurrence of its series, that stays on every time view, faded and struck through, while its
 * time reads as free (never busy, never Now or Next, never a travel anchor, never pushed to the
 * workspace calendar). Kept in the item's overlay, in TodoList only: never written to a provider,
 * never touched by a sync, and enabled again the same way.
 *
 * - `overlay.disabled`: the whole item; on a series, every occurrence. On a Google series it is set
 *   on the master and on each exception row of it at once (`setSeriesDisabled`), and an exception
 *   synced later reads as disabled while its master is (the shared expansion, types/recurrence).
 * - `overlay.disabledOccurrences`: one occurrence each of a series (a repeating time block or area,
 *   or a Google master's own slots), by original start, ISO 8601, sorted, at most
 *   DISABLED_OCCURRENCES_MAX (the oldest go first). A Google occurrence that has an exception row
 *   (moved, cancelled) is disabled on that row instead.
 *
 * Pure: the value object reads what is stored; the items write it (Item#setDisabled).
 */
import type { ItemOverlay } from '../../models/definitions/Item.js';
import type { DisableScope } from '../../types/items.js';

/** A Disable or an Enable, as callers give it. */
export interface DisableChange {
  disabled: boolean;
  /**
   * For an item that repeats, or one occurrence of a series: `series` (every occurrence) or
   * `occurrence` (one: `occurrenceStart`). Left out: one occurrence when `occurrenceStart` is given
   * or the item is itself one occurrence (a Google exception row), else the whole item.
   */
  scope?: DisableScope | undefined;
  /** The occurrence's original start (its start before any move). */
  occurrenceStart?: Date | undefined;
}

/** What the API answers when one occurrence of a series disabled as a whole is enabled. */
export const SERIES_DISABLED_MESSAGE =
  'scope: every occurrence of this series is disabled; enable the series (scope series)';

export class DisabledState {
  readonly #whole: boolean;
  readonly #occurrences: readonly string[];

  private constructor(whole: boolean, occurrences: readonly string[]) {
    this.#whole = whole;
    this.#occurrences = Object.freeze([...occurrences]);
    Object.freeze(this);
  }

  static of(overlay: Pick<ItemOverlay, 'disabled' | 'disabledOccurrences'>): DisabledState {
    return new DisabledState(overlay.disabled === true, overlay.disabledOccurrences);
  }

  /** How an occurrence's original start is stored. */
  static key(originalStart: Date): string {
    return originalStart.toISOString();
  }

  /** The whole item (every occurrence of a series). */
  get whole(): boolean {
    return this.#whole;
  }

  /** The occurrences disabled one by one (original starts, ISO 8601). */
  get occurrences(): readonly string[] {
    return this.#occurrences;
  }

  /** Whether the occurrence at this original start is disabled (on its own, or with the whole). */
  covers(originalStart: Date): boolean {
    return this.#whole || this.listed(originalStart);
  }

  /** Whether this occurrence is disabled on its own (in the list, not by the whole). */
  listed(originalStart: Date): boolean {
    const at = originalStart.getTime();
    return this.#occurrences.some((text) => new Date(text).getTime() === at);
  }
}
