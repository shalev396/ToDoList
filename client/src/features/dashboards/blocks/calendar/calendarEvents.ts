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

/** A solid fill under its ink; travel is hatched over its muted fill (`tc-travel`). */
export function toEventInput(
  item: DisplayedOccurrence,
  timeZone: string,
  colour: ItemColour,
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
    ],
    backgroundColor: paint.fill,
    borderColor: paint.fill,
    textColor: paint.ink,
    extendedProps,
    ...timing(o, timeZone),
  };
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
