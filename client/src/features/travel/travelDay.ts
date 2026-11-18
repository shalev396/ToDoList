/** `?travelDay=YYYY-MM-DD`: the day whose travel the day panel shows (urlVars.RESERVED_PARAMS). */
export const TRAVEL_DAY_PARAM = 'travelDay';

const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

/** The param's value as a real calendar day (`YYYY-MM-DD`); null for anything else. */
export function travelDayOf(value: string | null): string | null {
  if (value === null || !DAY_PATTERN.test(value)) {
    return null;
  }
  const day = new Date(`${value}T00:00:00.000Z`);
  return Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== value ? null : value;
}
