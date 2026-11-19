/**
 * Occurrences as FullCalendar events. FullCalendar has no zone database of its own, so the
 * calendar runs in its `UTC` zone and every event carries the wall clock of the workspace's
 * time zone (`2026-11-12T10:00:00`, no offset): it is drawn at that time whatever zone the browser
 * is in. Each event is painted in its colour (topic or subject, and role; features/colours), never
 * its source's; an area is a background band in its tint. Pure; unit-tested.
 */
import type { EventInput } from '@fullcalendar/core';
import type { ColourFamily, ColourRole, ItemColour } from '@api-types/colours.ts';
import { layerOf, type BlockLayer } from '@api-types/scheduled.ts';
import type { TravelMode } from '@api-types/travel.ts';
import { colourVar, paintOf } from '../../../colours/palette.ts';
import type { LegMarks } from '../../../travel/legView.ts';
import type { TapReach, TimedSpan } from './chipLayout.ts';
import { wallDate, wallString, type Occurrence } from '../time/occurrences.ts';
import type { Tone } from '../../rules/applyDisplayRules.ts';

/** A due-only item (a point in time) is drawn this long. */
export const POINT_MINUTES = 30;

export interface DisplayedOccurrence {
  occurrence: Occurrence;
  tone?: Tone | undefined;
  badges: readonly string[];
  /** A travel leg's marks and its title in the UI language (the title replaces the stored one). */
  leg?: LegMarks | undefined;
}

export interface CalendarEventProps {
  rowId: string;
  /** The item's kind (`block` and `travel` are reserved time). */
  kind: string;
  /** A time block's layer (`area` never reaches here: it is a band); null for any other kind. */
  layer: BlockLayer | null;
  /**
   * The slot this occurrence fills in its series (ISO), which opens the item sheet on it
   * (`?occurrence=`); null for an item that doesn't repeat.
   */
  originalStart: string | null;
  provider: string;
  dueOnly: boolean;
  tone: Tone | undefined;
  badges: readonly string[];
  url: string;
  family: ColourFamily;
  role: ColourRole;
  /** A travel leg that can't be made in time (red edge, "You can't make it"). */
  conflict: boolean;
  /** A travel leg that is over (dimmed). */
  past: boolean;
  /** A travel leg's mode (its icon); null for any other item. */
  legMode: TravelMode | null;
  /** A travel leg whose event moved since he edited it ("check this trip"). */
  anchorMoved: boolean;
  /** A leg whose trip has no length yet: drawn dashed. */
  lengthUnset: boolean;
  /**
   * Shorter than a line of text, with free time after it: drawn a line tall (`tc-stretch`, CSS
   * only; chipLayout.ts `stretchedEvents`).
   */
  stretched: boolean;
  /** A tiny chip's invisible hit area into the free time around it (chipLayout.ts `tapReach`). */
  tap: TapReach | null;
}

/** How a short event is drawn beyond its time (chipLayout.ts); never part of the overlap math. */
export interface ShortEventDrawing {
  stretched?: boolean;
  tap?: TapReach | undefined;
}

/**
 * An area's props: a band in the week grid (no click, no source), or a plain event in the month
 * grid and a phone list, where it opens the area's sheet on `originalStart`.
 */
export interface CalendarAreaProps {
  rowId: string;
  area: true;
  family: ColourFamily;
  originalStart: string | null;
}

function addDay(date: string, days = 1): string {
  const [y, m, d] = date.split('-').map(Number) as [number, number, number];
  return new Date(Date.UTC(y, m - 1, d + days)).toISOString().slice(0, 10);
}

/** A point's slot ends at midnight at the latest, so a 23:59 due date stays on its own day. */
function pointEnd(start: Date, timeZone: string): string {
  const startWall = wallString(start, timeZone);
  const endWall = wallString(new Date(start.getTime() + POINT_MINUTES * 60_000), timeZone);
  return endWall.slice(0, 10) > startWall.slice(0, 10)
    ? `${addDay(startWall.slice(0, 10))}T00:00:00`
    : endWall;
}

/** Where an occurrence sits on the calendar, in the workspace's wall clock. */
function timing(o: Occurrence, timeZone: string): EventInput {
  if (o.allDay) {
    const start = wallDate(o.start, timeZone);
    // An all-day event's end is the (exclusive) midnight after its last day.
    const last = o.end === null ? start : wallDate(new Date(o.end.getTime() - 1), timeZone);
    return { allDay: true, start, end: addDay(last < start ? start : last) };
  }
  const end =
    o.end === null ? (o.dueOnly ? pointEnd(o.start, timeZone) : null) : wallString(o.end, timeZone);
  return { allDay: false, start: wallString(o.start, timeZone), ...(end === null ? {} : { end }) };
}

/**
 * A solid fill under its ink; travel is hatched over its muted fill (`tc-travel`). A short event
 * may be drawn a line tall over the free time after it (`stretched`, `tc-stretch`), or keep its
 * height with a hit area into the free time around it (`tap`).
 */
export function toEventInput(
  item: DisplayedOccurrence,
  timeZone: string,
  colour: ItemColour,
  { stretched = false, tap }: ShortEventDrawing = {},
): EventInput {
  const { occurrence: o } = item;
  const paint = paintOf(colour);
  const extendedProps: CalendarEventProps = {
    rowId: o.row.id,
    kind: o.row.kind,
    layer: layerOf(o.row),
    originalStart: o.originalStart === null ? null : o.originalStart.toISOString(),
    provider: o.row.source.provider,
    dueOnly: o.dueOnly,
    tone: item.tone,
    badges: item.badges,
    url: o.row.source.url,
    family: colour.family,
    role: colour.role,
    conflict: item.leg?.conflict ?? false,
    past: item.leg?.past ?? false,
    legMode: item.leg?.mode ?? null,
    anchorMoved: item.leg?.moved ?? false,
    lengthUnset: item.leg?.unset ?? false,
    stretched,
    tap: tap ?? null,
  };
  // FullCalendar sets an event's attributes once, when its element is made (`eventDidMount`). A leg's
  // marks change under it (a conflict clears, the day moves on, he edits its times), so they are
  // part of its id: a leg that reads differently is drawn again.
  const legId =
    item.leg === undefined
      ? o.key
      : [
          o.key,
          o.start.getTime(),
          o.end?.getTime(),
          item.leg.conflict,
          item.leg.past,
          item.leg.moved,
          item.leg.unset,
        ]
          .map(String)
          .join('|');
  return {
    id: legId,
    title: item.leg?.title ?? o.row.title,
    classNames: [
      ...(colour.role === 'travel' ? ['tc-travel'] : []),
      ...(item.leg?.conflict === true ? ['tc-conflict'] : []),
      ...(item.leg?.past === true ? ['tc-past'] : []),
      ...(item.leg?.unset === true ? ['tc-unset'] : []),
      ...(o.dueOnly ? ['fc-due'] : []),
      ...(stretched ? ['tc-stretch'] : []),
    ],
    backgroundColor: paint.fill,
    borderColor: paint.fill,
    textColor: paint.ink,
    extendedProps,
    ...timing(o, timeZone),
  };
}

/**
 * The timed events' spans (instants, ms) for `stretchedEvents`: one without an end lasts as long
 * as it is drawn (a due date's point, FullCalendar's default length).
 */
export function timedSpans(items: readonly DisplayedOccurrence[]): TimedSpan[] {
  return items
    .filter(({ occurrence }) => !occurrence.allDay)
    .map(({ occurrence: o }) => ({
      key: o.key,
      start: o.start.getTime(),
      end: o.end?.getTime() ?? o.start.getTime() + POINT_MINUTES * 60_000,
    }));
}

/** An area: a band in its family's tint behind every event, its title on top (`tc-area`). */
export function toAreaEventInput(
  occurrence: Occurrence,
  colour: ItemColour,
  timeZone: string,
): EventInput {
  const extendedProps: CalendarAreaProps = {
    rowId: occurrence.row.id,
    area: true,
    family: colour.family,
    originalStart: occurrence.originalStart?.toISOString() ?? null,
  };
  return {
    id: occurrence.key,
    title: occurrence.row.title,
    display: 'background',
    backgroundColor: colourVar(colour.family, 'area'),
    classNames: ['tc-area'],
    extendedProps,
    ...timing(occurrence, timeZone),
  };
}

/**
 * An area named in the week grid's day header. Its band behind the events carries no visible label
 * (events would cover it, and a rail beside them took their width): the header does, and opens it.
 */
export interface AreaTag {
  key: string;
  rowId: string;
  title: string;
  family: ColourFamily;
  /** As `CalendarAreaProps.originalStart`: opens the sheet on this occurrence. */
  originalStart: string | null;
  /** Its wall-clock times (`HH:MM`); null for an all-day area. */
  from: string | null;
  to: string | null;
}

/** The days (`YYYY-MM-DD`, wall clock) an area's band covers, first to last. */
function daysCovered(o: Occurrence, timeZone: string): string[] {
  const { start, end } = timing(o, timeZone) as { start: string; end?: string };
  const first = start.slice(0, 10);
  let last = first;
  if (o.allDay && end !== undefined) {
    // The end is the exclusive midnight after the last day.
    last = new Date(Date.parse(`${end}T00:00:00Z`) - 1).toISOString().slice(0, 10);
  } else if (end !== undefined && end > start) {
    // An end at midnight closes the day before.
    last = end.slice(11) === '00:00:00' ? addDay(end.slice(0, 10), -1) : end.slice(0, 10);
  }
  const days: string[] = [];
  for (let day = first; day <= last && days.length < 62; day = addDay(day)) {
    days.push(day);
  }
  return days;
}

/** The areas each day of the grid shows in its header, in order of start. */
export function areaTagsByDay(
  areas: readonly Occurrence[],
  colourOf: (rowId: string) => ItemColour,
  timeZone: string,
): Map<string, AreaTag[]> {
  const byDay = new Map<string, AreaTag[]>();
  const sorted = [...areas].sort((a, b) => a.start.getTime() - b.start.getTime());
  for (const o of sorted) {
    const tag: AreaTag = {
      key: o.key,
      rowId: o.row.id,
      title: o.row.title,
      family: colourOf(o.row.id).family,
      originalStart: o.originalStart?.toISOString() ?? null,
      from: o.allDay ? null : wallString(o.start, timeZone).slice(11, 16),
      to: o.allDay || o.end === null ? null : wallString(o.end, timeZone).slice(11, 16),
    };
    for (const day of daysCovered(o, timeZone)) {
      byDay.set(day, [...(byDay.get(day) ?? []), tag]);
    }
  }
  return byDay;
}

/**
 * An area where FullCalendar draws no background (the month grid, a phone's list): a plain event
 * in the area's tint under the page ink, with its title, covering the period it spans. Not
 * draggable; a click opens the area's sheet on that occurrence.
 */
export function toAreaPeriodEventInput(
  occurrence: Occurrence,
  colour: ItemColour,
  timeZone: string,
): EventInput {
  const input = toAreaEventInput(occurrence, colour, timeZone);
  return {
    ...input,
    display: 'auto',
    editable: false,
    borderColor: colourVar(colour.family, 'scheduled'),
    textColor: 'var(--foreground)',
  };
}
