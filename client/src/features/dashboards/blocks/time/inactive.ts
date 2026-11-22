/**
 * Inactive occurrences (the owner's ruling of 2026-11-22): one the provider cancelled or the member
 * disabled in TodoList stays on every time view, faded and struck through (`tc-off` on the
 * calendars, the same look on the clock and in the lists), and its time reads as free: it is never
 * Now or Next, never painted time a drag lands in, never busy. Pure; unit-tested through the views'
 * models.
 */
import type { Inactive, Occurrence } from './occurrences.ts';

/** The class every calendar grid gives an inactive event or area (index.css). */
export const INACTIVE_CLASS = 'tc-off';

/** A listed title whose time is free: struck through and muted (InactiveTag beside it says why). */
export const INACTIVE_TITLE = 'text-muted-foreground line-through';

/** The words for why its time is free, in every language ("Cancelled", "Disabled"). */
export function inactiveKey(
  inactive: Inactive,
): 'timeBlocks.inactive.cancelled' | 'timeBlocks.inactive.disabled' {
  return inactive === 'cancelled'
    ? 'timeBlocks.inactive.cancelled'
    : 'timeBlocks.inactive.disabled';
}

/** The occurrences that take their time (neither cancelled nor disabled), in their order. */
export function activeOnly<O extends Pick<Occurrence, 'inactive'>>(occurrences: readonly O[]): O[] {
  return occurrences.filter((occurrence) => occurrence.inactive === null);
}

/**
 * A row's own inactive state, for what is drawn from the row rather than an occurrence (a planned
 * to-do's chip): cancelled at its provider (a declined event is never drawn), else disabled.
 */
export function rowInactive(row: {
  status: string;
  overlay?: { disabled?: boolean | null } | undefined;
}): Inactive | null {
  if (row.status === 'cancelled') {
    return 'cancelled';
  }
  return row.overlay?.disabled === true ? 'disabled' : null;
}
