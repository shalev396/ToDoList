/**
 * How a travel leg reads in the UI (docs/superpowers/specs/2026-11-17-travel-time-design.md,
 * "Conflicts", "Removal is visible"), as pure functions. The server stores each leg's title from an
 * English template (for MCP and pushes); every view draws it from `props.travel` through i18n, so
 * "Bus to Braude" reads "נסיעה באוטובוס לבראודה" in Hebrew. Titles name places only: no address and
 * no coordinate is ever in a leg's props.
 */
import type { TFunction } from 'i18next';
import {
  travelPropsOf,
  type RemovalReason,
  type TravelLegProps,
  type TravelMode,
} from '@api-types/travel.ts';

/** A Hebrew letter first: the "to" letter joins the name; any other script takes a hyphen. */
const HEBREW_FIRST = /^[\u0590-\u05FF]/;

/**
 * "Bus to Braude", "Walk home", "נסיעה באוטובוס לבראודה": the mode, and the place the leg goes to by
 * name. A leg whose place has no name takes `fallback` (the stored title's anchor), else "its
 * place".
 */
export function legTitle(
  t: TFunction,
  travel: Pick<TravelLegProps, 'mode' | 'toHome' | 'toName'>,
  fallback?: string,
): string {
  if (travel.toHome) {
    return t(`travel.leg.home.${travel.mode}`);
  }
  const name = travel.toName !== '' ? travel.toName : (fallback ?? t('travel.leg.somewhere'));
  return t(`travel.leg.title.${travel.mode}`, {
    place: name,
    dash: HEBREW_FIRST.test(name) ? '' : '-',
  });
}

/**
 * A removed trip's title in the UI language, from what the server says it was (`RemovedLegView`:
 * mode, whether it went home, the place's name); the stored English title when it says none.
 */
export function removedLegTitle(
  t: TFunction,
  removed: { title: string; mode?: TravelMode; toHome?: boolean; toName?: string },
): string {
  return removed.mode === undefined
    ? removed.title
    : legTitle(t, {
        mode: removed.mode,
        toHome: removed.toHome === true,
        toName: removed.toName ?? '',
      });
}

/** "Bus to Braude removed: the event was cancelled". `title` is the leg's title (`legTitle`). */
export function removalText(t: TFunction, reason: RemovalReason, title: string): string {
  return t('travel.leg.removal.text', {
    title,
    reason: t(`travel.leg.removal.reasons.${reason}`),
  });
}

/** What the leg's slot needs to say whether it is over. */
interface Slot {
  start: Date;
  end: Date | null;
}

/** A leg is past once it has ended (one under way is not); without an end, once it started. */
export function isPastLeg(occurrence: Slot, now: Date): boolean {
  return (occurrence.end ?? occurrence.start).getTime() <= now.getTime();
}

/**
 * What a view marks on a leg: its mode, the conflict, past, and "the event moved" flags, and
 * whether its trip has no length yet (`unset`: drawn dashed, with the placeholder length).
 */
export interface LegFlags {
  mode: TravelMode;
  conflict: boolean;
  past: boolean;
  moved: boolean;
  unset: boolean;
}

/** `LegFlags`, with the title in the UI language. */
export interface LegMarks extends LegFlags {
  title: string;
}

interface LegOccurrence extends Slot {
  row: { kind: string; props: Record<string, unknown> };
}

/** The leg's flags; null for anything that isn't a leg (or whose props aren't a leg's). */
export function legFlagsOf(occurrence: LegOccurrence, now: Date): LegFlags | null {
  if (occurrence.row.kind !== 'travel') {
    return null;
  }
  const travel = travelPropsOf(occurrence.row.props);
  return travel === null
    ? null
    : {
        mode: travel.mode,
        conflict: travel.conflict,
        past: isPastLeg(occurrence, now),
        moved: travel.anchorMoved,
        unset: travel.lengthUnset,
      };
}

/** The leg's flags and its title in the UI language; null for anything that isn't a leg. */
export function legMarksOf(t: TFunction, occurrence: LegOccurrence, now: Date): LegMarks | null {
  const flags = legFlagsOf(occurrence, now);
  const travel = flags === null ? null : travelPropsOf(occurrence.row.props);
  return flags === null || travel === null ? null : { ...flags, title: legTitle(t, travel) };
}

/** A row's title in the UI language: a travel leg's is drawn from its props, any other is its own. */
export function rowTitle(
  t: TFunction,
  row: { kind: string; title: string; props: Record<string, unknown> },
): string {
  if (row.kind !== 'travel') {
    return row.title;
  }
  const travel = travelPropsOf(row.props);
  return travel === null ? row.title : legTitle(t, travel);
}

/**
 * A red edge along the start of a row (a pseudo-element, so the row's content never shifts and it
 * flips in right-to-left pages), for a leg that can't be made in time.
 */
export const CONFLICT_EDGE =
  'relative before:absolute before:inset-y-1 before:-start-2 before:w-1 before:rounded-full before:bg-destructive';

/**
 * A dashed outline round a row, for a leg whose trip has no length yet (it is drawn with the
 * placeholder until he sets how long it takes). An outline: it takes no room and never shifts the
 * row.
 */
export const UNSET_OUTLINE =
  'rounded-sm outline-1 outline-offset-[-1px] outline-dashed outline-muted-foreground/70';

/**
 * "Thursday" and "10:30" of when a trip's event starts, on the workspace's wall clock: what "every
 * repeat" of an event that doesn't repeat by itself means (same weekday, same local start time).
 */
export function repeatPatternOf(
  anchorStart: string,
  timeZone: string,
  locale: string,
): { weekday: string; time: string } {
  const start = new Date(anchorStart);
  const time = new Intl.DateTimeFormat('en-GB', {
    timeZone,
    hourCycle: 'h23',
    hour: '2-digit',
    minute: '2-digit',
  }).format(start);
  return {
    weekday: new Intl.DateTimeFormat(locale, { weekday: 'long', timeZone }).format(start),
    time,
  };
}

/**
 * What "every repeat" means for a trip's event, for the words of the question: `series` (every
 * occurrence), `pattern` (a rule for the same title, weekday and time in its calendar or project),
 * `none` (it doesn't repeat and has no calendar: only this day), or `unknown` while the event is not
 * read (loading, failed): the words claim nothing.
 */
export function repeatsKindOf(
  occurrence: string,
  anchor: { containerId: string | null; series: boolean } | null,
): 'series' | 'pattern' | 'none' | 'unknown' {
  if (occurrence !== 'single') {
    return 'series';
  }
  if (anchor === null) {
    return 'unknown';
  }
  if (anchor.series) {
    return 'series';
  }
  return anchor.containerId === null ? 'none' : 'pattern';
}
