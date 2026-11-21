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
  /** The event's own (provider) title, as `repeatTitleOf` has it. */
  title: string;
  /** 0 (Sunday) to 6, on the workspace's wall clock. */
  weekday: number;
  /** `HH:mm`, local start time. */
  startTime: string;
  /** The chosen event's start (ISO): the rule applies from it on. */
  from: string;
}

const pad = (value: number): string => String(value).padStart(2, '0');

/** The longest title a repeats rule keeps (the most a synced title can be). */
export const REPEATS_TITLE_MAX = 1000;

/** A title as repeats compare it: trimmed and Unicode-normalised (NFC); case counts. */
export function repeatTitleOf(title: string): string {
  return title.trim().normalize('NFC');
}

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

/**
 * Of the repeats rules that match an event, the one chosen from the latest start (its `from`):
 * choices made from different weeks each mean "from this one on". The first of equal ones.
 */
export function latestRepeats<T extends { scope: RepeatsScope }>(
  rules: readonly T[],
  event: { containerId: string | null; title: string; startAt: Date },
  timeZone: string,
): T | null {
  let best: T | null = null;
  for (const rule of rules) {
    if (!matchesRepeats(rule.scope, event, timeZone)) continue;
    if (best === null || Date.parse(rule.scope.from) > Date.parse(best.scope.from)) best = rule;
  }
  return best;
}

/**
 * Whether a non-repeating event (its container, its own title and start) is a repeat the scope
 * names: same calendar or project and title, the same weekday and local time, at or after `from`.
 */
export function matchesRepeats(
  scope: RepeatsScope,
  event: { containerId: string | null; title: string; startAt: Date },
  timeZone: string,
): boolean {
  if (event.containerId !== scope.containerId || repeatTitleOf(event.title) !== scope.title)
    return false;
  if (event.startAt.getTime() < new Date(scope.from).getTime()) return false;
  const slot = repeatSlotOf(event.startAt, timeZone);
  return slot.weekday === scope.weekday && slot.startTime === scope.startTime;
}
