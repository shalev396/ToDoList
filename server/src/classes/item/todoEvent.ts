/**
 * The Google Calendar event a to-do becomes (H5's copy, plan Addendum A3's recurring to-do): at its
 * due date, all day (the day it falls on in the workspace's zone; Google's end date exclusive), or
 * a half hour from its time. Pure.
 */
import type { PlainEventBody } from '../integration/index.js';
import { cleanTitle } from '../../services/providerCreate/fields.js';
import { sha256Hex } from '../../services/crypto/hashing.js';

const HALF_HOUR_MS = 30 * 60 * 1000;
/** How much of a to-do's note an event's description takes. */
export const EVENT_NOTE_MAX = 500;

/** What of a to-do the event is made from. */
export interface TodoEventSource {
  readonly title: string;
  readonly note: string | null;
  readonly dueAt: Date | null;
  readonly allDay: boolean;
}

/** Google event ids are base32hex: a stable one per request makes a repeat the same event. */
export function eventIdFor(requestId: string): string {
  return `h5${sha256Hex(requestId).slice(0, 40)}`;
}

/** The event, or null without a due date or a title. */
export function todoEvent(
  todo: TodoEventSource,
  timeZone: string,
  eventId: string,
): PlainEventBody | null {
  const summary = cleanTitle(todo.title);
  if (todo.dueAt === null || summary === null) return null;
  const description = todo.note === null ? '' : todo.note.slice(0, EVENT_NOTE_MAX);
  if (todo.allDay) {
    const day = todo.dueAt.toLocaleDateString('en-CA', { timeZone });
    const next = new Date(`${day}T12:00:00Z`);
    next.setUTCDate(next.getUTCDate() + 1);
    return {
      id: eventId,
      summary,
      description,
      start: { date: day },
      end: { date: next.toISOString().slice(0, 10) },
      status: 'confirmed',
    };
  }
  const end = new Date(todo.dueAt.getTime() + HALF_HOUR_MS);
  return {
    id: eventId,
    summary,
    description,
    start: { dateTime: todo.dueAt.toISOString(), timeZone },
    end: { dateTime: end.toISOString(), timeZone },
    status: 'confirmed',
  };
}
