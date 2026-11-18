/** `?travelDay=YYYY-MM-DD`: the day whose travel the day panel shows (urlVars.RESERVED_PARAMS). */
export const TRAVEL_DAY_PARAM = 'travelDay';

/**
 * History state on the entry that opened the day panel (a link pushes it), so closing the panel
 * goes back over that entry the way the item sheet does, and Back then closes it too.
 */
export const DAY_SHEET_STATE = { travelDaySheet: true } as const;

/** Whether this history entry is one a link pushed to open the day panel. */
export function openedDaySheet(state: unknown): boolean {
  return (state as { travelDaySheet?: boolean } | null)?.travelDaySheet === true;
}

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The param's value as a real calendar day (`YYYY-MM-DD`); null for anything else. */
export function travelDayOf(value: string | null): string | null {
  if (value === null || !DAY_PATTERN.test(value)) {
    return null;
  }
  const day = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value ? null : value;
}
