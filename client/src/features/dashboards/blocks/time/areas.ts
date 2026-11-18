/**
 * Areas (time-blocks design, "Areas"): painted time for a part of life, drawn behind everything
 * else. A row is an area when its colour's role is `area` (the shared rule reads the block's
 * layer), so every time view splits them out the same way. Pure; unit-tested.
 */
import type { ItemColour } from '@api-types/colours.ts';

/** The areas apart from everything else, each list in its given order. */
export function splitAreas<O extends { row: { id: string } }>(
  occurrences: readonly O[],
  colourOf: (rowId: string) => ItemColour,
): { areas: O[]; items: O[] } {
  const areas: O[] = [];
  const items: O[] = [];
  for (const occurrence of occurrences) {
    (colourOf(occurrence.row.id).role === 'area' ? areas : items).push(occurrence);
  }
  return { areas, items };
}

export interface AreaGroup<O> {
  area: O | null;
  items: O[];
}

/** An area without an end holds nothing. */
const endOf = (slot: { start: Date; end: Date | null }): number =>
  (slot.end ?? slot.start).getTime();

/**
 * Chronological groups: each item goes under the first area (by start, then the longer) with
 * area.start <= item.start < area.end; items outside every area form area-null groups between; an
 * area with no items still yields its group.
 */
export function nestInAreas<O extends { start: Date; end: Date | null }>(
  items: readonly O[],
  areas: readonly O[],
): AreaGroup<O>[] {
  const byStart = (a: O, b: O) => a.start.getTime() - b.start.getTime();
  const groups = [...areas]
    .sort((a, b) => byStart(a, b) || endOf(b) - endOf(a))
    .map((area) => ({ area, items: [] as O[] }));
  const loose: O[] = [];
  for (const item of [...items].sort(byStart)) {
    const at = item.start.getTime();
    const group = groups.find(({ area }) => area.start.getTime() <= at && at < endOf(area));
    (group?.items ?? loose).push(item);
  }

  // The areas and the loose items by start (a stable sort: an area goes first on a tie).
  const timeline = [
    ...groups.map((group) => ({ at: group.area.start.getTime(), group })),
    ...loose.map((item) => ({ at: item.start.getTime(), item })),
  ].sort((a, b) => a.at - b.at || Number('item' in a) - Number('item' in b));
  const result: AreaGroup<O>[] = [];
  for (const entry of timeline) {
    const last = result.at(-1);
    if ('group' in entry) {
      result.push(entry.group);
    } else if (last?.area === null) {
      last.items.push(entry.item);
    } else {
      result.push({ area: null, items: [entry.item] });
    }
  }
  return result;
}

/** A time kept in its own left-to-right run, so a range keeps its order inside Hebrew text. */
export function isolateLtr(text: string): string {
  return `⁦${text}⁩`;
}

/** User text kept in its own run, so its direction never bends the text around it. */
export function isolateAuto(text: string): string {
  return `⁨${text}⁩`;
}
