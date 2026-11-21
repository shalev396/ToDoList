/**
 * The timesheet (a topic's painted time, with its open to-dos beside it to drag onto the week), as
 * pure functions: what the grid draws (areas as bands, time blocks, planned to-dos as chips), the
 * panel's order, the plan a drop makes, and what a drag across the grid opens. The topic it reads
 * is timesheetTopic.ts's. Unit-tested.
 *
 * A plan is the overlay's `plannedAt` (server PlannedAt): `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, on
 * the workspace's wall clock. FullCalendar runs in its `UTC` zone holding that wall clock
 * (calendarEvents.ts), so a drop's date reads straight into a plan and a plan straight into an
 * event, whatever zone the browser is in.
 */
import type { EventInput } from '@fullcalendar/core';
import type { ItemQueryRow, QueryResult } from '@api-types/builder.ts';
import type { ColourFamily, ColourRole, ItemColour } from '@api-types/colours.ts';
import { fromWallString } from '@api-types/recurrence/zoned.ts';
import { layerOf } from '@api-types/scheduled.ts';
import { paintOf } from '../../../colours/palette.ts';
import type { NewItemPreset } from '../../../items/create/timeBlockDraft.ts';
import { parsePlannedAt } from '../../../items/plannedAt.ts';
import { presetFromSelection, type WallSelection } from '../../../items/scheduled/dragPreset.ts';
import { splitAreas } from '../time/areas.ts';
import { expandOccurrences, wallString, type Occurrence, type Range } from '../time/occurrences.ts';

/** A planned to-do is drawn this long: a plan has a start and no stored length. */
export const PLANNED_MINUTES = 30;
/** Drops land on quarter hours. */
export const SNAP_MINUTES = 15;
/** FullCalendar's `snapDuration` for the week grid. */
export const SNAP_DURATION = `00:${String(SNAP_MINUTES)}:00`;

const MINUTE_MS = 60_000;

/** Timed rows: drawn by their own times. Everything else the timesheet reads is a to-do. */
const TIMED_KINDS: ReadonlySet<string> = new Set(['event', 'block', 'travel']);

export function isTodoRow(row: Pick<ItemQueryRow, 'kind'>): boolean {
  return !TIMED_KINDS.has(row.kind);
}

/**
 * The plan a drop makes: the wall time FullCalendar dropped on, on the quarter hour it falls in
 * (`YYYY-MM-DDTHH:mm`), or the day alone for a drop on the all-day row (`YYYY-MM-DD`).
 */
export function plannedAtFromDrop(date: Date, allDay: boolean): string {
  if (allDay) {
    return date.toISOString().slice(0, 10);
  }
  const step = SNAP_MINUTES * MINUTE_MS;
  return new Date(Math.floor(date.getTime() / step) * step).toISOString().slice(0, 16);
}

/** `YYYY-MM-DDTHH:mm` plus some minutes, as FullCalendar's wall string (`…:00`). */
function addWallMinutes(wall: string, minutes: number): string {
  const ms = Date.parse(`${wall}:00Z`) + minutes * MINUTE_MS;
  return new Date(ms).toISOString().slice(0, 19);
}

function nextDay(date: string): string {
  return new Date(Date.parse(`${date}T00:00:00Z`) + 24 * 60 * MINUTE_MS).toISOString().slice(0, 10);
}

/** A to-do's plan in the visible range (`[from, to)`, read on the workspace's wall clock). */
export function plannedInRange(
  plannedAt: string | null | undefined,
  range: Range,
  timeZone: string,
): boolean {
  const { date, time } = parsePlannedAt(plannedAt);
  if (date === '') {
    return false;
  }
  const from = wallString(range.from, timeZone).slice(0, 16);
  const to = wallString(range.to, timeZone).slice(0, 16);
  const at = time === '' ? `${date}T00:00` : `${date}T${time}`;
  return at >= from && at < to;
}

/** What the panel compares: when a to-do is planned and when it is due. */
type PanelRow = Pick<ItemQueryRow, 'id' | 'title' | 'overlay'> & {
  dueAt: Date | string | null;
};

function dueMs(row: PanelRow): number {
  return row.dueAt === null ? Number.POSITIVE_INFINITY : new Date(row.dueAt).getTime();
}

function planOf(row: PanelRow): string | null {
  const { date, time } = parsePlannedAt(row.overlay.plannedAt);
  return date === '' ? null : time === '' ? date : `${date}T${time}`;
}

/**
 * The panel's order: the to-dos with no plan first (soonest due first, undated last), then the
 * planned ones (earliest plan first); the title, then the id, settle ties.
 */
export function panelOrder<R extends PanelRow>(rows: readonly R[]): R[] {
  const byTitle = (a: R, b: R) => a.title.localeCompare(b.title) || a.id.localeCompare(b.id);
  const unplanned = rows.filter((row) => planOf(row) === null);
  const planned = rows.filter((row) => planOf(row) !== null);
  unplanned.sort((a, b) => dueMs(a) - dueMs(b) || byTitle(a, b));
  planned.sort((a, b) => (planOf(a) ?? '').localeCompare(planOf(b) ?? '') || byTitle(a, b));
  return [...unplanned, ...planned];
}

export interface TimesheetModel {
  /** Painted time: bands behind everything. */
  areas: Occurrence[];
  /** Time blocks (and any other timed row), drawn as events. */
  timed: Occurrence[];
  /** Every to-do, in the panel's order. */
  todos: ItemQueryRow[];
  /** The to-dos planned inside the visible range: chips on the grid. */
  planned: ItemQueryRow[];
}

/**
 * What the timesheet draws from its rows: the areas and the time blocks of the visible range
 * (series expanded on the workspace's wall clock), and the to-dos. `showBlocks` off leaves the
 * time blocks out (the areas stay).
 */
export function buildTimesheet(
  rows: readonly ItemQueryRow[],
  range: Range,
  timeZone: string,
  colourOf: (rowId: string) => ItemColour,
  showBlocks: boolean,
): TimesheetModel {
  const timedRows = rows.filter((row) => !isTodoRow(row));
  const todos = panelOrder(rows.filter(isTodoRow));
  const { areas, items } = splitAreas(expandOccurrences(timedRows, range, timeZone), colourOf);
  return {
    areas,
    timed: items.filter((o) => showBlocks || layerOf(o.row) !== 'block'),
    todos,
    planned: todos.filter((row) => plannedInRange(row.overlay.plannedAt, range, timeZone)),
  };
}

export interface PlannedEventProps {
  rowId: string;
  planned: true;
  provider: string;
  family: ColourFamily;
  role: ColourRole;
  /** The stored plan, which the chip's label reads. */
  plannedAt: string;
}

/**
 * A planned to-do as a chip: at its plan for PLANNED_MINUTES (or on the all-day row for a plan
 * without a time), in its colour, draggable but not resizable (a plan has no length to change).
 * Null for a to-do with no plan.
 */
export function plannedEventInput(row: ItemQueryRow, colour: ItemColour): EventInput | null {
  const { date, time } = parsePlannedAt(row.overlay.plannedAt);
  if (date === '') {
    return null;
  }
  const plannedAt = time === '' ? date : `${date}T${time}`;
  const paint = paintOf(colour);
  const extendedProps: PlannedEventProps = {
    rowId: row.id,
    planned: true,
    provider: row.source.provider,
    family: colour.family,
    role: colour.role,
    plannedAt,
  };
  const timing: EventInput =
    time === ''
      ? { allDay: true, start: date, end: nextDay(date) }
      : {
          allDay: false,
          start: `${plannedAt}:00`,
          end: addWallMinutes(plannedAt, PLANNED_MINUTES),
        };
  return {
    // Drawn again when its plan, title or colour changes (FullCalendar keeps an element per id).
    id: ['plan', row.id, plannedAt, row.title, colour.family, colour.role].join('|'),
    title: row.title,
    editable: true,
    startEditable: true,
    durationEditable: false,
    classNames: ['tc-planned'],
    backgroundColor: paint.fill,
    borderColor: paint.fill,
    textColor: paint.ink,
    extendedProps,
    ...timing,
  };
}

/** The block's cached result with one to-do's plan changed: the optimistic write. */
export function withPlan(
  data: QueryResult | undefined,
  itemId: string,
  plannedAt: string | null,
): QueryResult | undefined {
  if (data?.rows === undefined) {
    return data;
  }
  return {
    ...data,
    rows: data.rows.map((row) =>
      row.id === itemId && 'overlay' in row
        ? { ...row, overlay: { ...row.overlay, plannedAt } }
        : row,
    ),
  };
}

/**
 * The New sheet a drag across the grid opens. Over free time: a new area of the timesheet's topic
 * at that time (painting the time sheet). Inside painted time: a time block there, on the area's
 * topic, as the calendar does (dragPreset.ts).
 */
export function selectionPreset(
  selection: WallSelection,
  areas: readonly Occurrence[],
  timeZone: string,
  topicId: string | null,
): NewItemPreset {
  const start = fromWallString(selection.startWall, timeZone);
  const end = fromWallString(selection.endWall, timeZone);
  const painted = areas.some(
    (area) =>
      area.start.getTime() < end.getTime() && (area.end ?? area.start).getTime() > start.getTime(),
  );
  if (painted) {
    return presetFromSelection(selection, areas, timeZone);
  }
  return { kind: 'area', start, end, ...(topicId === null ? {} : { topicId }) };
}
