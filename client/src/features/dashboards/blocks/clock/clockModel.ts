/**
 * What the clock block shows for today: the timed events as ring arcs, the all-day items listed
 * under the ring, and which event is on now and which is next. Pure; unit-tested.
 */
import { endOfZonedDay, startOfZonedDay } from './ClockRing.math.ts';
import { expandOccurrences, type Occurrence, type TimeRow } from '../time/occurrences.ts';

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
  /** The event on now (the latest-started when several overlap), if any. */
  current: Occurrence | null;
  /** The first event that starts after now. */
  next: Occurrence | null;
}

export function buildClockModel(rows: readonly TimeRow[], now: Date, timeZone: string): ClockModel {
  const day = { from: startOfZonedDay(now, timeZone), to: endOfZonedDay(now, timeZone) };
  const all = expandOccurrences(rows, day, timeZone);
  const allDay = all.filter((o) => o.allDay);
  const timedOccurrences = all.filter((o) => !o.allDay && !o.dueOnly);
  const timed: ClockEvent[] = timedOccurrences.map((o) => ({
    id: o.key,
    title: o.row.title,
    start: o.start,
    end: o.end ?? new Date(o.start.getTime() + DEFAULT_LENGTH_MS),
    source: ringProvider(o.row.source.provider),
  }));
  const nowMs = now.getTime();
  let current: Occurrence | null = null;
  let next: Occurrence | null = null;
  for (const [index, o] of timedOccurrences.entries()) {
    const end = timed[index]?.end.getTime() ?? o.start.getTime();
    if (o.start.getTime() <= nowMs && nowMs < end) {
      current = o;
    } else if (o.start.getTime() > nowMs && next === null) {
      next = o;
    }
  }
  return { timed, timedOccurrences, allDay, current, next };
}
