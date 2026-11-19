/**
 * The clock's legend (topic-colours spec, "Accessibility"): colour is never the only cue, so the
 * ring is followed by the names of the families it shows, a subject or a topic each. Pure;
 * unit-tested.
 */
import type { ItemColour } from '@api-types/colours.ts';

export interface LegendEntry {
  key: string;
  label: string;
  colour: ItemColour;
}

/** Past this many names, the rest are counted ("+2 more"). */
const MAX_ENTRIES = 6;

/** The distinct family and name pairs, in the order first seen; marks without a colour are skipped. */
export function legendEntries(
  events: readonly { colour?: ItemColour }[],
  labelOf: (colour: ItemColour) => string,
  max: number = MAX_ENTRIES,
): { entries: LegendEntry[]; more: number } {
  const seen = new Map<string, LegendEntry>();
  for (const { colour } of events) {
    if (colour === undefined) {
      continue;
    }
    const label = labelOf(colour);
    const key = `${colour.family}|${label}`;
    if (!seen.has(key)) {
      seen.set(key, { key, label, colour });
    }
  }
  const all = [...seen.values()];
  return { entries: all.slice(0, max), more: Math.max(0, all.length - max) };
}
