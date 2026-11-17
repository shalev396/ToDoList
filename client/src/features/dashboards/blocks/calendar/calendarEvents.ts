/**
 * Occurrences as FullCalendar events. FullCalendar has no zone database of its own, so the
 * calendar runs in its `UTC` zone and every event carries the wall clock of the workspace's
 * time zone (`2026-11-12T10:00:00`, no offset): it is drawn at that time whatever zone the browser
 * is in. Pure; unit-tested.
 */
import type { EventInput } from '@fullcalendar/core';
import { wallDate, wallString, type Occurrence } from '../time/occurrences.ts';
import type { Tone } from '../../rules/applyDisplayRules.ts';

/** A due-only item (a point in time) is drawn this long. */
export const POINT_MINUTES = 30;

export interface DisplayedOccurrence {
  occurrence: Occurrence;
  tone?: Tone | undefined;
  badges: readonly string[];
}

export interface CalendarEventProps {
  rowId: string;
  provider: string;
  dueOnly: boolean;
  tone: Tone | undefined;
  badges: readonly string[];
  url: string;
}

function addDay(date: string): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + 1)).toISOString().slice(0, 10);
}

/** A point's slot ends at midnight at the latest, so a 23:59 due date stays on its own day. */
function pointEnd(start: Date, timeZone: string): string {
  const startWall = wallString(start, timeZone);
  const endWall = wallString(new Date(start.getTime() + POINT_MINUTES * 60_000), timeZone);
  return endWall.slice(0, 10) > startWall.slice(0, 10)
    ? `${addDay(startWall.slice(0, 10))}T00:00:00`
    : endWall;
}

export function toEventInput(item: DisplayedOccurrence, timeZone: string): EventInput {
  const { occurrence: o } = item;
  const extendedProps: CalendarEventProps = {
    rowId: o.row.id,
    provider: o.row.source.provider,
    dueOnly: o.dueOnly,
    tone: item.tone,
    badges: item.badges,
    url: o.row.source.url,
  };
  const base = {
    id: o.key,
    title: o.row.title,
    classNames: [`fc-src-${o.row.source.provider}`, ...(o.dueOnly ? ['fc-due'] : [])],
    extendedProps,
  };
  if (o.allDay) {
    const start = wallDate(o.start, timeZone);
    // An all-day event's end is the (exclusive) midnight after its last day.
    const last = o.end === null ? start : wallDate(new Date(o.end.getTime() - 1), timeZone);
    return { ...base, allDay: true, start, end: addDay(last < start ? start : last) };
  }
  const end =
    o.end === null ? (o.dueOnly ? pointEnd(o.start, timeZone) : null) : wallString(o.end, timeZone);
  return {
    ...base,
    allDay: false,
    start: wallString(o.start, timeZone),
    ...(end === null ? {} : { end }),
  };
}
