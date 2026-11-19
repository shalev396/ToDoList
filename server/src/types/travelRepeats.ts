/**
 * "Every repeat" of an event that does not repeat by itself (an imported timetable keeps each
 * lecture as its own event): the weekday and local start time that make two events the same slot
 * of a week. Shared with the client (`@api-types/travelRepeats`). Pure.
 */
import { zonedParts } from './recurrence/zoned.js';

/** A repeats rule's scope (TravelRuleScope `repeats`). */
export interface RepeatsScope {
  kind: 'repeats';
  containerId: string;
  title: string;
  /** 0 (Sunday) to 6, on the workspace's wall clock. */
  weekday: number;
  /** `HH:mm`, local start time. */
  startTime: string;
  /** The chosen event's start (ISO): the rule applies from it on. */
  from: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** An event's weekday and local start time in `timeZone`. */
export function repeatSlotOf(
  start: Date,
  timeZone: string,
): { weekday: number; startTime: string } {
  const { year, month, day, hour, minute } = zonedParts(start, timeZone);
  return {
    weekday: new Date(Date.UTC(year, month - 1, day)).getUTCDay(),
    startTime: `${pad(hour)}:${pad(minute)}`,
  };
}

/** Whether a non-repeating event (its container, title and start) is a repeat the scope names. */
export function matchesRepeats(
  scope: RepeatsScope,
  event: { containerId: string | null; title: string; startAt: Date },
  timeZone: string,
): boolean {
  if (event.containerId !== scope.containerId || event.title !== scope.title) return false;
  if (event.startAt.getTime() < new Date(scope.from).getTime()) return false;
  const slot = repeatSlotOf(event.startAt, timeZone);
  return slot.weekday === scope.weekday && slot.startTime === scope.startTime;
}
