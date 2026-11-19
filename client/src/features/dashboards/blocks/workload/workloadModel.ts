/**
 * The workload block (H3): hours per day over the visible week, from calendar events (their
 * length) plus the estimates of the tasks due that day (story points count 4 hours each, as
 * importance does; server types/workload.ts). A task with no estimate counts as nothing and is
 * listed as unestimated, so a light-looking day is never a silent guess. Pure; unit-tested.
 */
import { isScheduledKind, layerOf } from '@api-types/scheduled.ts';
import { estimateHours } from '@api-types/workload.ts';
import type { ItemQueryRow } from '@api-types/builder.ts';
import { endOfZonedDay, startOfZonedDay } from '../clock/ClockRing.math.ts';
import {
  expandOccurrences,
  toDate,
  wallDate,
  weekRange,
  type WeekStart,
} from '../time/occurrences.ts';

const HOUR_MS = 60 * 60 * 1000;

export interface WorkloadDay {
  /** `2026-11-12`: the local date. */
  date: string;
  /** Midnight of that day, in the workspace's zone. */
  start: Date;
  eventHours: number;
  taskHours: number;
  totalHours: number;
  /** The day holds more than the capacity. */
  over: boolean;
}

export interface WorkloadModel {
  days: WorkloadDay[];
  totalHours: number;
  /** The most any day holds: the bars' scale. */
  peakHours: number;
  /** Tasks due this week with no estimate (counted as nothing). */
  unestimated: ItemQueryRow[];
}

/** Reserved time that holds the day: an event, a block (not an area) or a travel leg. */
function isBusy(row: ItemQueryRow): boolean {
  if (row.status === 'cancelled') {
    return false;
  }
  return row.kind === 'event' || row.kind === 'travel' || layerOf(row) === 'block';
}

const round = (hours: number): number => Math.round(hours * 100) / 100;

/** The days of the week that contains `anchor`, in the workspace's zone (7 local days). */
function weekDays(
  anchor: Date,
  timeZone: string,
  weekStart: WeekStart,
): { start: Date; end: Date }[] {
  const week = weekRange(anchor, timeZone, weekStart);
  const days: { start: Date; end: Date }[] = [];
  let start = week.from;
  for (let index = 0; index < 7; index += 1) {
    const end = endOfZonedDay(start, timeZone);
    days.push({ start, end });
    start = end;
  }
  return days;
}

export function buildWorkload(
  rows: readonly ItemQueryRow[],
  anchor: Date,
  timeZone: string,
  weekStart: WeekStart,
  capacityHours: number,
): WorkloadModel {
  const week = weekDays(anchor, timeZone, weekStart);
  const range = {
    from: week[0]?.start ?? startOfZonedDay(anchor, timeZone),
    to: week[6]?.end ?? anchor,
  };
  // Busy time: events, time blocks and travel legs. An area is painted time, not busy.
  const events = rows.filter(isBusy);
  const occurrences = expandOccurrences(events, range, timeZone);

  const unestimated: ItemQueryRow[] = [];
  const days = week.map(({ start, end }): WorkloadDay => {
    let eventMs = 0;
    for (const occurrence of occurrences) {
      if (occurrence.allDay || occurrence.dueOnly || occurrence.end === null) {
        continue;
      }
      const from = Math.max(occurrence.start.getTime(), start.getTime());
      const to = Math.min(occurrence.end.getTime(), end.getTime());
      if (to > from) {
        eventMs += to - from;
      }
    }
    let taskHours = 0;
    for (const row of rows) {
      if (
        row.kind === 'event' ||
        isScheduledKind(row.kind) ||
        row.status === 'done' ||
        row.status === 'cancelled'
      ) {
        continue;
      }
      const when = toDate(row.dueAt) ?? toDate(row.startAt);
      if (when === null || when < start || when >= end) {
        continue;
      }
      const hours = estimateHours(row);
      if (hours === null) {
        unestimated.push(row);
      } else {
        taskHours += hours;
      }
    }
    const eventHours = eventMs / HOUR_MS;
    const total = eventHours + taskHours;
    return {
      date: wallDate(start, timeZone),
      start,
      eventHours: round(eventHours),
      taskHours: round(taskHours),
      totalHours: round(total),
      over: total > capacityHours,
    };
  });
  return {
    days,
    totalHours: round(days.reduce((sum, day) => sum + day.totalHours, 0)),
    peakHours: days.reduce((peak, day) => Math.max(peak, day.totalHours), 0),
    unestimated,
  };
}
