/**
 * What a create's title may be, for every provider (H5): trimmed, at most TITLE_MAX characters.
 * Pure: the write client's body builders (classes/integration/writers) use it, and the calendar
 * event of a to-do takes its summary from it.
 */
export const TITLE_MAX = 255;

/** The title as sent: trimmed, at most TITLE_MAX characters; null when nothing is left. */
export function cleanTitle(title: string): string | null {
  const trimmed = title.trim();
  if (trimmed === '') return null;
  return Array.from(trimmed).slice(0, TITLE_MAX).join('').trim();
}
