/**
 * What the clock block shows for today: the timed events as ring arcs, the areas as a band
 * around them, the all-day items listed under the ring, and which event is on now and which is
 * next. A cancelled or disabled occurrence keeps its arc (drawn hollow and faded), but its time is
 * free: it is never Now or Next. Pure; unit-tested.
 */
import type { ItemColour } from '@api-types/colours.ts';
import { endOfZonedDay, startOfZonedDay } from './ClockRing.math.ts';
import { legFlagsOf, type LegFlags } from '../../../travel/legView.ts';
import { splitAreas } from '../time/areas.ts';
import {
  expandOccurrences,
  type Inactive,
  type Occurrence,
  type TimeRow,
} from '../time/occurrences.ts';

/** An event without an end is drawn this long. */
const DEFAULT_LENGTH_MS = 30 * 60_000;

type Provider = 'google_calendar' | 'jira' | 'clickup' | 'linear' | 'moodle' | 'github' | 'local';

const RING_PROVIDERS: ReadonlySet<string> = new Set<Provider>([
  'google_calendar',
  'jira',
  'clickup',
  'linear',
  'moodle',
  'github',
  'local',
]);

/** One arc of the ring (the shape ClockRing draws). */
export interface ClockEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  source: Provider;
  /** A provider the ring has no colour for: it draws in the muted ink, not as local to-dos. */
  reserved?: boolean;
  /** Its colour (topic or subject, and role); without one it draws in its source colour (the landing demos). */
  colour?: ItemColour;
  /** A travel leg's marks (mode, conflict, past, "the event moved"); null for any other item. */
  leg?: LegFlags | null;
  /** Cancelled or disabled: a hollow, faded arc, its time free. */
  inactive?: Inactive | null;
}

/** Painted time for a part of life: a band just outside the ring, behind the arcs. */
export interface ClockArea {
  id: string;
  title: string;
  start: Date;
  end: Date;
  /** The topic the area is painted for (its colour's), if any. */
  topicId: string | null;
  colour: ItemColour;
  /** Cancelled or disabled: a faded band. */
  inactive?: Inactive | null;
}

export function isRingProvider(provider: string): boolean {
  return RING_PROVIDERS.has(provider);
}

/** A provider the ring has a colour for; one without (a future source) draws as local. */
export function ringProvider(provider: string): Provider {
  return RING_PROVIDERS.has(provider) ? (provider as Provider) : 'local';
}

export interface ClockModel {
  /** Today's timed events, in start order, for the ring (which clips them to the day). */
  timed: ClockEvent[];
  /** The same events with their rows, in the same order. */
  timedOccurrences: Occurrence[];
  /** All-day items: listed, never drawn. */
  allDay: Occurrence[];
  /** The event on now (the latest-started when several overlap), if any; never an inactive one. */
  current: Occurrence | null;
  /** The first event that starts after now; never an inactive one. */
  next: Occurrence | null;
  /** Today's areas, in start order: a band, never an arc, Now or Next. */
  areas: ClockArea[];
}

const endOf = (o: Occurrence): Date => o.end ?? new Date(o.start.getTime() + DEFAULT_LENGTH_MS);

/**
 * An instant on the local day after the one containing `now`: the day the "Tomorrow" ring
 * shows. It is the first millisecond of that day, so a day that starts at 01:00 (a skipped
 * midnight) is still the right one.
 */
export function tomorrowOf(now: Date, timeZone: string): Date {
  return new Date(endOfZonedDay(now, timeZone).getTime() + 1);
}

/**
 * Without `colourOf` there are no areas and every arc keeps its source colour. `titleOf` gives a
 * row's title in the UI language (a travel leg's is drawn from its props); it defaults to the
 * stored one. `day` is the instant whose local day is drawn (now, unless it is tomorrow's ring
 * (`tomorrowOf`)); Now and Next are always about `now`, so tomorrow has no current event.
 */
export function buildClockModel(
  rows: readonly TimeRow[],
  now: Date,
  timeZone: string,
  colourOf?: (rowId: string) => ItemColour,
  titleOf: (row: TimeRow) => string = (row) => row.title,
  dayOf: Date = now,
  hidden: readonly TimeRow[] = [],
): ClockModel {
  const day = { from: startOfZonedDay(dayOf, timeZone), to: endOfZonedDay(dayOf, timeZone) };
  // What a display rule hides still takes its slot out of its series (never listed).
  let all = expandOccurrences(rows, day, timeZone, { hidden });
  let areas: ClockArea[] = [];
  if (colourOf !== undefined) {
    const split = splitAreas(all, colourOf);
    all = split.items;
    areas = split.areas.map((o) => ({
      id: o.key,
      title: o.row.title,
      start: o.start,
      end: endOf(o),
      topicId: colourOf(o.row.id).topicId,
      colour: colourOf(o.row.id),
      inactive: o.inactive,
    }));
  }
  const allDay = all.filter((o) => o.allDay);
  const timedOccurrences = all.filter((o) => !o.allDay && !o.dueOnly);
  const timed: ClockEvent[] = timedOccurrences.map((o) => ({
    id: o.key,
    title: titleOf(o.row),
    start: o.start,
    end: endOf(o),
    source: ringProvider(o.row.source.provider),
    ...(isRingProvider(o.row.source.provider) ? {} : { reserved: true }),
    leg: legFlagsOf({ row: o.row, start: o.start, end: endOf(o) }, now),
    inactive: o.inactive,
    ...(colourOf === undefined ? {} : { colour: colourOf(o.row.id) }),
  }));
  const nowMs = now.getTime();
  let current: Occurrence | null = null;
  let next: Occurrence | null = null;
  for (const [index, o] of timedOccurrences.entries()) {
    if (o.inactive !== null) {
      // Cancelled or disabled: its time is free.
      continue;
    }
    const end = timed[index]?.end.getTime() ?? o.start.getTime();
    if (o.start.getTime() <= nowMs && nowMs < end) {
      current = o;
    } else if (o.start.getTime() > nowMs && next === null) {
      next = o;
    }
  }
  return { timed, timedOccurrences, allDay, current, next, areas };
}
