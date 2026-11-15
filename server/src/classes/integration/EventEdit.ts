/**
 * One edit of a Google Calendar event (CalendarProvider#updateEvent), validated: a value object,
 * in the item's own vocabulary (`title`, `startAt`, `endAt`, `allDay`; the definition's
 * `writableFields` are `title`, `startAt`, `endAt`), plus `description`, which Google takes but an
 * item doesn't keep. Its time is given whole (`startAt` and `endAt` together, with `allDay`), so the event never ends up
 * half timed and half all-day; as a patch, a changed time clears the other form (`date` or
 * `dateTime`), since Google merges a patch into the event. An all-day event runs from the day
 * `startAt` falls on in the workspace's zone up to the day `endAt` falls on, that day excluded (as
 * Google and a pulled event's item keep it); an `endAt` on the start's day is that one day. Pure:
 * no provider, no database.
 */
import { z } from 'zod';

import { localDateString } from '../../sync/providers/trackerCommon.js';
import { parseOr400 } from '../../utils/validation.js';
import { OneLineTitle } from './TaskEdit.js';
import type { EventChanges, EventTimeChange } from './writers/calendarApi.js';

/** What an event's edit changes, by name (the audit's `fields`). */
export type EventField = 'title' | 'description' | 'startAt' | 'endAt';

const DESCRIPTION_MAX = 8000;
const Instant = z.date().refine((date) => !Number.isNaN(date.getTime()), 'Must be a valid date');

const Patch = z
  .strictObject({
    title: OneLineTitle.optional(),
    description: z.string().max(DESCRIPTION_MAX).nullable().optional(),
    startAt: Instant.optional(),
    endAt: Instant.optional(),
    allDay: z.boolean().optional(),
  })
  .refine((patch) => Object.keys(patch).length > 0, 'At least one change is required')
  .refine(
    (patch) =>
      (patch.startAt === undefined && patch.endAt === undefined && patch.allDay === undefined) ||
      (patch.startAt !== undefined && patch.endAt !== undefined),
    { message: 'A time is given whole: startAt and endAt together', path: ['startAt'] },
  )
  .refine(
    (patch) =>
      patch.startAt === undefined ||
      patch.endAt === undefined ||
      (patch.allDay === true ? patch.endAt >= patch.startAt : patch.endAt > patch.startAt),
    { message: 'Must come after startAt', path: ['endAt'] },
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
  /** What it changes, by name (the audit's `fields`). */
  readonly fields: readonly EventField[];

  private constructor(changes: EventChanges, fields: EventField[]) {
    this.changes = Object.freeze(changes);
    this.fields = Object.freeze(fields);
    Object.freeze(this);
  }

  /** The edit, validated (400 naming the field), its time placed in `timeZone`. */
  static parse(patch: unknown, timeZone: string): EventEdit {
    const parsed = parseOr400(Patch, patch);
    const changes: EventChanges = {};
    const fields: EventField[] = [];
    if (parsed.title !== undefined) {
      changes.summary = parsed.title;
      fields.push('title');
    }
    if (parsed.description !== undefined) {
      changes.description = parsed.description ?? '';
      fields.push('description');
    }
    if (parsed.startAt !== undefined && parsed.endAt !== undefined) {
      const time = EventEdit.#time(parsed.startAt, parsed.endAt, parsed.allDay === true, timeZone);
      changes.start = time.start;
      changes.end = time.end;
      fields.push('startAt', 'endAt');
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
