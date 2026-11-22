/**
 * The agenda block (H3): phone-first, what is on now, what is next, what is later today, then
 * tomorrow, with the day boundaries in the workspace's time zone. Pure; unit-tested.
 *
 * - Overdue: open tasks due before today (first). Earlier today: tasks due today whose time has
 *   passed. Now: only what is happening at this moment, an event in progress. All day: today's
 *   all-day items.
 * - Next: the first thing still to come today (everything starting at that same minute).
 * - Later today: the rest of today.
 * - Tomorrow: everything on the next local day.
 * - A cancelled or disabled occurrence (its time free) stays listed, faded and struck through, but
 *   is never Now or Next: an event on now or still to come today is in Later today; a task due
 *   today is in Earlier or Later today by its time. Overdue lists a disabled open task (faded: it
 *   is still to do, or to enable), never a cancelled one (a cancelled task is not overdue), as
 *   MCP `list_today` does.
 */
import { isScheduledKind } from '@api-types/scheduled.ts';
import { endOfZonedDay } from '../clock/ClockRing.math.ts';
import { nestInAreas, type AreaGroup } from '../time/areas.ts';
import { expandOccurrences, type Occurrence, type TimeRow } from '../time/occurrences.ts';
import { startOfZonedDay } from '../clock/ClockRing.math.ts';

/** An event without an end counts as on for this long. */
const DEFAULT_LENGTH_MS = 30 * 60_000;
const MINUTE_MS = 60_000;

export interface AgendaModel {
  /** Open tasks due before today, oldest first. */
  overdue: Occurrence[];
  /** Tasks due earlier today whose time has passed. */
  earlierToday: Occurrence[];
  /** Only what is happening at this moment: events in progress. */
  now: Occurrence[];
  /** All-day items of today. */
  allDay: Occurrence[];
  next: Occurrence[];
  laterToday: Occurrence[];
  tomorrow: Occurrence[];
}

/** How far back an overdue task is still listed. */
const OVERDUE_DAYS = 90;
const DAY_MS = 24 * 60 * 60 * 1000;

function endOf(occurrence: Occurrence): number {
  return (occurrence.end ?? new Date(occurrence.start.getTime() + DEFAULT_LENGTH_MS)).getTime();
}

/** A task (not an event, not reserved time) that is not done. */
function isUndoneTask(occurrence: Occurrence): boolean {
  const { row } = occurrence;
  return row.kind !== 'event' && !isScheduledKind(row.kind) && row.status !== 'done';
}

/** A task still to do: neither done nor cancelled (a disabled one is still to do). */
function isOpenTask(occurrence: Occurrence): boolean {
  return isUndoneTask(occurrence) && occurrence.row.status !== 'cancelled';
}

export function buildAgenda(rows: readonly TimeRow[], now: Date, timeZone: string): AgendaModel {
  const todayStart = startOfZonedDay(now, timeZone);
  const todayEnd = endOfZonedDay(now, timeZone);
  const tomorrowEnd = endOfZonedDay(todayEnd, timeZone);
  const from = new Date(todayStart.getTime() - OVERDUE_DAYS * DAY_MS);
  const all = expandOccurrences(rows, { from, to: tomorrowEnd }, timeZone);
  const nowMs = now.getTime();

  const model: AgendaModel = {
    overdue: [],
    earlierToday: [],
    now: [],
    allDay: [],
    next: [],
    laterToday: [],
    tomorrow: [],
  };
  const upcoming: Occurrence[] = [];
  // Cancelled or disabled, on now or still to come today: Later today, never Now or Next.
  const freed: Occurrence[] = [];
  for (const occurrence of all) {
    const startMs = occurrence.start.getTime();
    if (startMs < todayStart.getTime()) {
      // Before today: only an open task still counts (it is overdue); past events are history.
      if (occurrence.dueOnly && isOpenTask(occurrence)) {
        model.overdue.push(occurrence);
      }
    } else if (startMs >= todayEnd.getTime()) {
      model.tomorrow.push(occurrence);
    } else if (occurrence.allDay) {
      model.allDay.push(occurrence);
    } else if (occurrence.inactive !== null && !occurrence.dueOnly) {
      if (startMs > nowMs || nowMs < endOf(occurrence)) {
        freed.push(occurrence);
      }
    } else if (occurrence.dueOnly) {
      // A cancelled or disabled task due today stays, faded, but never decides Next.
      if (!isUndoneTask(occurrence) || (occurrence.inactive === null && !isOpenTask(occurrence))) {
        continue;
      }
      if (startMs <= nowMs) {
        model.earlierToday.push(occurrence);
      } else if (occurrence.inactive === null) {
        upcoming.push(occurrence);
      } else {
        freed.push(occurrence);
      }
    } else if (startMs <= nowMs && nowMs < endOf(occurrence)) {
      model.now.push(occurrence);
    } else if (startMs > nowMs) {
      upcoming.push(occurrence);
    }
  }
  const [first] = upcoming;
  if (first !== undefined) {
    const slot = Math.floor(first.start.getTime() / MINUTE_MS);
    for (const occurrence of upcoming) {
      if (Math.floor(occurrence.start.getTime() / MINUTE_MS) === slot) {
        model.next.push(occurrence);
      } else {
        model.laterToday.push(occurrence);
      }
    }
  }
  if (freed.length > 0) {
    model.laterToday = [...model.laterToday, ...freed].sort(
      (a, b) => a.start.getTime() - b.start.getTime() || a.key.localeCompare(b.key),
    );
  }
  return model;
}

/** Whether there is nothing in any part. */
export function isEmptyAgenda(model: AgendaModel): boolean {
  return (
    model.overdue.length +
      model.earlierToday.length +
      model.now.length +
      model.allDay.length +
      model.next.length +
      model.laterToday.length +
      model.tomorrow.length ===
    0
  );
}

export type AgendaPart = keyof AgendaModel;
export const AGENDA_PARTS: readonly AgendaPart[] = [
  'overdue',
  'earlierToday',
  'now',
  'allDay',
  'next',
  'laterToday',
  'tomorrow',
];

const holds = (area: Occurrence, item: Occurrence): boolean =>
  area.start <= item.start && item.start < (area.end ?? area.start);

/**
 * Where each area goes. `model` is the agenda of the items, `areaModel` the agenda of the areas
 * alone (only to find their occurrences and what is still to come).
 *
 * - An area appears in every part that holds an item starting inside it (areas may overlap: an
 *   area whose items went to the first one still shows, empty).
 * - An area with no item anywhere is listed in the part where it starts, placed by start time
 *   against the items' parts: what is on now is Now; a later start is Next when it is no later
 *   than the next items, else Later today.
 * - Within a part, areas and loose items are in time order (`nestInAreas`).
 */
export function agendaAreas(
  model: AgendaModel,
  areaModel: AgendaModel,
): Record<AgendaPart, AreaGroup<Occurrence>[]> {
  const everyItem = AGENDA_PARTS.flatMap((part) => model[part]);
  const nextAt = model.next[0]?.start.getTime();
  const placed = (part: AgendaPart, area: Occurrence): AgendaPart =>
    part === 'next' || part === 'laterToday'
      ? nextAt === undefined || area.start.getTime() <= nextAt
        ? 'next'
        : 'laterToday'
      : part;
  const listed = AGENDA_PARTS.flatMap((part) =>
    areaModel[part].map((area) => ({ area, part: placed(part, area) })),
  );

  const result = {} as Record<AgendaPart, AreaGroup<Occurrence>[]>;
  for (const part of AGENDA_PARTS) {
    const areas = listed
      .filter(
        ({ area, part: at }) =>
          model[part].some((item) => holds(area, item)) ||
          (at === part && !everyItem.some((item) => holds(area, item))),
      )
      .map(({ area }) => area);
    result[part] = nestInAreas(model[part], areas);
  }
  return result;
}
