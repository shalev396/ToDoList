/**
 * `?occurrence=<epoch ms>`: the occurrence of a repeating item the item sheet is on (its original
 * start). Its own module, free of the expansion (rrule), so the shell's sheet hook stays small. Pure.
 */

/** The longest epoch-ms text taken (year 2286 has 13 digits). */
const EPOCH_MS = /^\d{1,13}$/;

/** `?occurrence=<epoch ms>`: the occurrence a sheet opens on; null for anything else. */
export function parseOccurrenceParam(value: string | null): Date | null {
  if (value === null || !EPOCH_MS.test(value)) {
    return null;
  }
  const date = new Date(Number(value));
  return Number.isNaN(date.getTime()) ? null : date;
}
