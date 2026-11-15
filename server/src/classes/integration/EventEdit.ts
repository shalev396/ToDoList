/**
 * One edit of a Google Calendar event (CalendarProvider#updateEvent), validated: a value object.
 * Its time is given whole (`start` and `end` together, with `allDay`), so the event never ends up
 * half timed and half all-day; as a patch, a changed time clears the other form (`date` or
 * `dateTime`), since Google merges a patch into the event. An all-day event runs from the day
 * `start` falls on in the workspace's zone up to the day `end` falls on, that day excluded (as
 * Google and a pulled event's item keep it); an `end` on the start's day is that one day. Pure:
 * no provider, no database.
 */
import { z } from 'zod';

import { TITLE_MAX } from '../../services/providerCreate/fields.js';
import { localDateString } from '../../sync/providers/trackerCommon.js';
import { parseOr400 } from '../../utils/validation.js';
import type { EventChanges, EventTimeChange } from './writers/calendarApi.js';

const DESCRIPTION_MAX = 8000;
const Instant = z.date().refine((date) => !Number.isNaN(date.getTime()), 'Must be a valid date');

const Patch = z
  .strictObject({
    title: z.string().trim().min(1).max(TITLE_MAX).optional(),
    description: z.string().max(DESCRIPTION_MAX).nullable().optional(),
    start: Instant.optional(),
    end: Instant.optional(),
    allDay: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one change is required')
  .refine(
    (patch) =>
      (patch.start === undefined && patch.end === undefined && patch.allDay === undefined) ||
      (patch.start !== undefined && patch.end !== undefined),
    { message: 'A time is given whole: start and end together', path: ['start'] },
  )
  .refine(
    (patch) =>
      patch.start === undefined ||
      patch.end === undefined ||
      (patch.allDay === true ? patch.end >= patch.start : patch.end > patch.start),
    { message: 'Must come after start', path: ['end'] },
  );

/** The next calendar day of a `YYYY-MM-DD` date. */
function nextDay(date: string): string {
  const next = new Date(`${date}T12:00:00Z`);
  next.setUTCDate(next.getUTCDate() + 1);
  return next.toISOString().slice(0, 10);
}

export class EventEdit {
  /** What Google is sent (a patch). */
  readonly changes: Readonly<EventChanges>;
  /** What it changes, by name: `title`, `description`, `time` (the audit's `fields`). */
  readonly fields: readonly string[];

  private constructor(changes: EventChanges, fields: string[]) {
    this.changes = Object.freeze(changes);
    this.fields = Object.freeze(fields);
    Object.freeze(this);
  }

  /** The edit, validated (400 naming the field), its time placed in `timeZone`. */
  static parse(patch: unknown, timeZone: string): EventEdit {
    const parsed = parseOr400(Patch, patch);
    const changes: EventChanges = {};
    const fields: string[] = [];
    if (parsed.title !== undefined) {
      changes.summary = parsed.title;
      fields.push('title');
    }
    if (parsed.description !== undefined) {
      changes.description = parsed.description ?? '';
      fields.push('description');
    }
    if (parsed.start !== undefined && parsed.end !== undefined) {
      const time = EventEdit.#time(parsed.start, parsed.end, parsed.allDay === true, timeZone);
      changes.start = time.start;
      changes.end = time.end;
      fields.push('time');
    }
    return new EventEdit(changes, fields);
  }

  static #time(
    start: Date,
    end: Date,
    allDay: boolean,
    timeZone: string,
  ): { start: EventTimeChange; end: EventTimeChange } {
    if (!allDay) {
      return {
        start: { dateTime: start.toISOString(), timeZone, date: null },
        end: { dateTime: end.toISOString(), timeZone, date: null },
      };
    }
    const first = localDateString(start, timeZone);
    const last = localDateString(end, timeZone);
    const after = nextDay(first);
    return {
      start: { date: first, dateTime: null, timeZone: null },
      // Google's end date is exclusive; an end on the start's day is that one day.
      end: { date: last > first ? last : after, dateTime: null, timeZone: null },
    };
  }
}
