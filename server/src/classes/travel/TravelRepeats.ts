/**
 * The repeats of a timed item that does not repeat by itself (docs: plan of 2026-11-19, Task 3):
 * an imported timetable keeps every lecture as its OWN event, so "every repeat" of one is the
 * later events that are the same lecture again: in the same calendar or project, with exactly the
 * same title, on the same weekday at the same local start time (the workspace's zone), from that
 * event on. A later copy moved by an hour, one on another weekday, one elsewhere or an earlier one
 * is not a repeat. Events that are cancelled, all-day, repeating themselves or travel never are.
 *
 * Read-only: it reads the items the caller sees and writes nothing.
 */
import type { ItemQueryRow, Query } from '../../types/builder.js';
import { isSeriesRow } from '../../types/recurrence/occurrences.js';
import { zonedParts } from '../../types/recurrence/zoned.js';
import type { Caller } from '../base/Caller.js';
import { ItemQuery } from '../item/ItemQuery.js';

/** The most items one read looks through (a timetable is a few hundred events). */
export const REPEATS_ROWS_MAX = 1000;

/** How far ahead repeats are looked for: a semester and well beyond. */
const REPEATS_AHEAD_MS = 400 * 24 * 60 * 60 * 1000;

/** A weekday and a local time of day: what makes two events the same slot of a week. */
function slotOf(start: Date, timeZone: string): string {
  const { year, month, day, hour, minute } = zonedParts(start, timeZone);
  const weekday = new Date(Date.UTC(year, month - 1, day)).getUTCDay();
  return [weekday, hour, minute].map(String).join('|');
}

export class TravelRepeats {
  readonly #caller: Caller;

  private constructor(caller: Caller) {
    this.#caller = caller;
  }

  /** The repeats of the events the caller sees. */
  static of(caller: Caller): TravelRepeats {
    return new TravelRepeats(caller);
  }

  /**
   * The ids of the anchor and of every later repeat of it, by start (the anchor first). `anchor`
   * is the event itself (its title, container and start as stored).
   */
  async from(anchor: {
    id: string;
    title: string;
    containerId: string | null;
    startAt: Date;
  }): Promise<string[]> {
    const caller = this.#caller;
    const draft: Query = {
      source: 'items',
      where: {
        combinator: 'and',
        rules: [
          { field: 'title', operator: '=', value: anchor.title },
          { field: 'startAt', operator: '>=', value: anchor.startAt.toISOString() },
          {
            field: 'startAt',
            operator: '<',
            value: new Date(anchor.startAt.getTime() + REPEATS_AHEAD_MS).toISOString(),
          },
          { field: 'kind', operator: '!=', value: 'travel' },
          ...(anchor.containerId === null
            ? []
            : [{ field: 'containerId', operator: '=' as const, value: anchor.containerId }]),
        ],
      },
      sort: [{ field: 'startAt', dir: 'asc' }],
      limit: REPEATS_ROWS_MAX,
    };
    const result = await (await ItemQuery.for(caller)).runDraft(draft, { now: new Date() });
    const zone = caller.settings.timezone;
    const slot = slotOf(anchor.startAt, zone);
    const same = (result.rows ?? [])
      .filter((row): row is ItemQueryRow => 'kind' in row)
      .filter(
        (row) =>
          row.startAt !== null &&
          row.startAt >= anchor.startAt &&
          row.title === anchor.title &&
          row.containerId === anchor.containerId &&
          row.status !== 'cancelled' &&
          !row.allDay &&
          !isSeriesRow(row) &&
          slotOf(row.startAt, zone) === slot,
      )
      .sort((a, b) => (a.startAt?.getTime() ?? 0) - (b.startAt?.getTime() ?? 0));
    const ids = same.map((row) => row.id).filter((id) => id !== anchor.id);
    return [anchor.id, ...ids];
  }
}
