/**
 * A time block (or an area) in the item sheet, as pure functions (time-blocks design, "One source
 * of truth for repeating blocks"): which occurrence the sheet is on (`?occurrence=<epoch ms>`, the
 * occurrence's original start), its times now, the skips still to come, what its rule says, and
 * the edits a save sends.
 *
 * A repeating block is one record; an occurrence is computed by the shared expansion
 * (`@api-types/recurrence`). "This one" changes only one occurrence's start and end (an exception
 * keyed by its original start); the title, the subject and the page always change for all of them
 * (plan Ruling 2), so only a new time asks which.
 */
import type { ItemDetail } from '@api-types/items.ts';
import {
  DST_SLACK_MS,
  expandOccurrences,
  isSeriesRow,
  localExceptionsOf,
  toDate,
  wallDate,
  type TimeRow,
} from '@api-types/recurrence/occurrences.ts';
import { addLocalDays } from '@api-types/recurrence/zoned.ts';
import type { BlockLayer } from '@api-types/scheduled.ts';
import type { EditTimeBlockRequest, TimeBlockEditScope } from '@api-types/timeBlocks.ts';
import { SUBJECT_ATTRIBUTE_KEY } from '@api-types/attributes.ts';
import { WEEKDAYS, type Frequency, type Weekday } from '../create/recurrence.ts';
import { dateInZone, instantInZone, timeInZone } from '../zonedDate.ts';

/** What these functions read of the item sheet's item. */
export type BlockItem = Pick<
  ItemDetail,
  | 'id'
  | 'kind'
  | 'title'
  | 'status'
  | 'startAt'
  | 'endAt'
  | 'dueAt'
  | 'allDay'
  | 'topicId'
  | 'source'
  | 'props'
> & { overlay: Pick<ItemDetail['overlay'], 'topicOverride' | 'attrs'> };

export interface Span {
  start: Date;
  end: Date;
}

/** One occurrence of a repeating block. */
export interface OccurrenceView {
  /** Its slot's start (before any move): what keys its exception. */
  originalStart: Date;
  /** Its times as the rule makes them. */
  slot: Span;
  /** Its times now: the slot's, or the ones it was moved to. */
  start: Date;
  end: Date;
  moved: boolean;
  skipped: boolean;
}

export interface BlockView {
  repeating: boolean;
  /** The occurrence the sheet is on; null for a block that doesn't repeat, or a series as a whole. */
  occurrence: OccurrenceView | null;
  /** The times shown and edited: the occurrence's, else the block's own (a series' first). */
  start: Date;
  end: Date;
  /** The skipped occurrences still to come (their original starts), oldest first. */
  skipped: Date[];
}

function rowOf(item: BlockItem, withExceptions: boolean): TimeRow {
  return {
    id: item.id,
    kind: item.kind,
    title: item.title,
    status: item.status,
    startAt: item.startAt,
    endAt: item.endAt,
    dueAt: item.dueAt,
    allDay: item.allDay,
    source: item.source,
    props: withExceptions ? item.props : { ...item.props, exceptions: [] },
  };
}

/** The block's own span (a series' first occurrence). */
function ownSpan(item: BlockItem): Span {
  const start = toDate(item.startAt) ?? new Date(0);
  return { start, end: toDate(item.endAt) ?? start };
}

/**
 * The slot of a repeating block that starts at `originalStart`, as its rule makes it (exceptions
 * left out); null when it has no such slot. The window is wider than any DST jump, as the server's
 * check is (TimeBlock#hasSlot).
 */
export function slotAt(item: BlockItem, originalStart: Date, timeZone: string): Span | null {
  if (!isSeriesRow(item)) {
    return null;
  }
  const at = originalStart.getTime();
  const found = expandOccurrences(
    [rowOf(item, false)],
    { from: new Date(at - DST_SLACK_MS), to: new Date(at + DST_SLACK_MS) },
    timeZone,
  ).find((occurrence) => occurrence.originalStart?.getTime() === at);
  return found === undefined ? null : { start: found.start, end: found.end ?? found.start };
}

export function blockViewOf(
  item: BlockItem,
  occurrence: Date | null,
  timeZone: string,
  now: Date,
): BlockView {
  const repeating = isSeriesRow(item);
  const exceptions = localExceptionsOf(item.props);
  const skipped = repeating
    ? exceptions
        .filter((entry) => entry.skipped === true)
        .map((entry) => new Date(entry.originalStart))
        .filter((date) => date.getTime() >= now.getTime())
        .sort((a, b) => a.getTime() - b.getTime())
    : [];
  const slot = occurrence === null ? null : slotAt(item, occurrence, timeZone);
  if (slot === null || occurrence === null) {
    return { repeating, occurrence: null, ...ownSpan(item), skipped };
  }
  const exception = exceptions.find(
    (entry) => new Date(entry.originalStart).getTime() === occurrence.getTime(),
  );
  const skippedHere = exception?.skipped === true;
  const start = skippedHere ? null : toDate(exception?.startAt ?? null);
  const end = skippedHere ? null : toDate(exception?.endAt ?? null);
  const view: OccurrenceView = {
    originalStart: occurrence,
    slot,
    start: start ?? slot.start,
    end: end ?? slot.end,
    moved: start !== null || end !== null,
    skipped: skippedHere,
  };
  return { repeating, occurrence: view, start: view.start, end: view.end, skipped };
}

/** "Bring it back": the occurrence at its slot's own times, which removes its exception. */
export function restoreRequestOf(
  item: BlockItem,
  originalStart: Date,
  timeZone: string,
): EditTimeBlockRequest | null {
  const slot = slotAt(item, originalStart, timeZone);
  return slot === null
    ? null
    : {
        scope: 'this',
        originalStart: originalStart.toISOString(),
        startAt: slot.start.toISOString(),
        endAt: slot.end.toISOString(),
      };
}

/** What the edit form holds. */
export interface BlockDraft {
  title: string;
  /** '' for none. */
  subject: string;
  /** null = Unsorted. */
  topicId: string | null;
  start: Date;
  end: Date;
}

export function subjectOf(item: Pick<BlockItem, 'overlay'>): string {
  const value = item.overlay.attrs[SUBJECT_ATTRIBUTE_KEY];
  return typeof value === 'string' ? value : '';
}

/** Its page: one it was moved to by hand (an override) wins over its own. */
export function topicOf(item: Pick<BlockItem, 'topicId' | 'overlay'>): string | null {
  return item.overlay.topicOverride ?? item.topicId;
}

/** The form as it opens: the block's values, at the times the sheet shows. */
export function blockDraftOf(item: BlockItem, view: BlockView): BlockDraft {
  return {
    title: item.title,
    subject: subjectOf(item),
    topicId: topicOf(item),
    start: view.start,
    end: view.end,
  };
}

/** Why the name can't be saved: an area needs a title; a block a title or a subject. */
export type NameProblem = 'areaTitle' | 'titleOrSubject';

export function nameProblem(
  layer: BlockLayer,
  draft: Pick<BlockDraft, 'title' | 'subject'>,
): NameProblem | null {
  if (draft.title.trim() !== '') {
    return null;
  }
  if (layer === 'area') {
    return 'areaTitle';
  }
  return draft.subject.trim() === '' ? 'titleOrSubject' : null;
}

/** What a save sends. */
export interface BlockSave {
  /** A new time on one occurrence of a repeating block: "This one" or "All". */
  asksScope: boolean;
  /** The PATCHes for "This one", in order (only when it asks). */
  this: EditTimeBlockRequest[];
  /**
   * The PATCHes for "All" (or for the only choice when it doesn't ask); empty when nothing
   * changed. Null when every occurrence can't move that way (a day of the month pushed out of it).
   */
  all: EditTimeBlockRequest[] | null;
  /**
   * The page changed while one set by hand (`overlay.topicOverride`) is on it: that override is
   * cleared too (an overlay PATCH after the edits), or it would keep winning over the saved page.
   */
  clearTopicOverride: boolean;
}

/** Whole days from one `YYYY-MM-DD` to another. */
function daysBetween(from: string, to: string): number {
  const utc = (date: string) => {
    const [y = 1970, m = 1, d = 1] = date.split('-').map(Number);
    return Date.UTC(y, m - 1, d);
  };
  return Math.round((utc(to) - utc(from)) / 86_400_000);
}

/** Each BYDAY day moved `shift` days (Monday first, as the rules are written). */
function shiftDays(value: string, shift: number): string | null {
  const days = value.split(',');
  if (!days.every((day): day is Weekday => (WEEKDAYS as readonly string[]).includes(day))) {
    return null;
  }
  const moved = new Set(
    days.flatMap((day) => WEEKDAYS[(((WEEKDAYS.indexOf(day) + shift) % 7) + 7) % 7] ?? []),
  );
  return WEEKDAYS.filter((day) => moved.has(day)).join(',');
}

/** Each BYMONTHDAY day moved `shift` days; null when one leaves 1–31 (or isn't a plain day). */
function shiftMonthDays(value: string, shift: number): string | null {
  const days = value.split(',').map((day) => (/^\d{1,2}$/.test(day) ? Number(day) + shift : 0));
  return days.every((day) => day >= 1 && day <= 31) ? days.join(',') : null;
}

/** The rule with its days moved `shift` days; null when it can't be. */
function shiftedRule(lines: readonly string[], shift: number): string[] | null {
  const out: string[] = [];
  for (const line of lines) {
    const match = /^RRULE:(.*)$/i.exec(line.trim());
    if (match === null) {
      out.push(line);
      continue;
    }
    const parts: string[] = [];
    for (const part of (match[1] ?? '').split(';')) {
      const [key = '', value = ''] = part.split('=');
      const name = key.toUpperCase();
      const moved =
        name === 'BYDAY'
          ? shiftDays(value.toUpperCase(), shift)
          : name === 'BYMONTHDAY'
            ? shiftMonthDays(value, shift)
            : value;
      if (moved === null) {
        return null;
      }
      parts.push(`${key}=${moved}`);
    }
    out.push(`RRULE:${parts.join(';')}`);
  }
  return out;
}

const recurrenceOf = (item: BlockItem): string[] =>
  Array.isArray(item.props['recurrence'])
    ? (item.props['recurrence'] as unknown[]).filter(
        (line): line is string => typeof line === 'string',
      )
    : [];

/**
 * "All" from one occurrence: the series' first occurrence moved the way this one was. The new
 * time of day is on the wall clock (so a series that began before a DST change keeps it), a day
 * moved moves the series' start and its days of the week with it, and the length is the new one.
 */
function seriesTimes(
  item: BlockItem,
  from: Date,
  draft: Span,
  timeZone: string,
): Pick<EditTimeBlockRequest, 'startAt' | 'endAt' | 'recurrence'> | null {
  const shift = daysBetween(dateInZone(from, timeZone), dateInZone(draft.start, timeZone));
  const first = ownSpan(item).start;
  const day = wallDate(addLocalDays(first, shift, timeZone), timeZone);
  const start = new Date(instantInZone(day, timeInZone(draft.start, timeZone), timeZone));
  const end = new Date(start.getTime() + (draft.end.getTime() - draft.start.getTime()));
  const times = { startAt: start.toISOString(), endAt: end.toISOString() };
  if (shift === 0) {
    return times;
  }
  const lines = recurrenceOf(item);
  const recurrence = shiftedRule(lines, shift);
  if (recurrence === null) {
    return null;
  }
  return recurrence.join('\n') === lines.join('\n') ? times : { ...times, recurrence };
}

/**
 * What a save sends. The title (a blank one is the subject), the subject (blank clears it) and the
 * page go to the whole series; a new time on one occurrence of a repeating block asks "This one"
 * (an exception) or "All" (the series). A block that doesn't repeat, or a series opened as a
 * whole, saves all of it at once. The page shown is the one saved: a new page also clears a page
 * set by hand, and the block's own page is sent only when it differs from it.
 */
export function blockSaveOf(
  item: BlockItem,
  view: BlockView,
  base: BlockDraft,
  draft: BlockDraft,
  timeZone: string,
): BlockSave {
  const fields: EditTimeBlockRequest = { scope: 'all' };
  const subject = draft.subject.trim();
  const title = draft.title.trim() === '' ? subject : draft.title.trim();
  if (title !== '' && title !== base.title.trim()) {
    fields.title = title;
  }
  if (subject !== base.subject.trim()) {
    fields.subject = subject === '' ? null : subject;
  }
  const pageChanged = draft.topicId !== base.topicId;
  if (pageChanged && draft.topicId !== item.topicId) {
    fields.topicId = draft.topicId;
  }
  const clearTopicOverride = pageChanged && item.overlay.topicOverride !== null;
  const changed = Object.keys(fields).length > 1;
  const timeChanged =
    draft.start.getTime() !== base.start.getTime() || draft.end.getTime() !== base.end.getTime();
  const times = { startAt: draft.start.toISOString(), endAt: draft.end.toISOString() };
  const occurrence = view.occurrence;

  if (!timeChanged) {
    return { asksScope: false, this: [], all: changed ? [fields] : [], clearTopicOverride };
  }
  if (occurrence === null) {
    return { asksScope: false, this: [], all: [{ ...fields, ...times }], clearTopicOverride };
  }
  const thisOne: EditTimeBlockRequest = {
    scope: 'this' satisfies TimeBlockEditScope,
    originalStart: occurrence.originalStart.toISOString(),
    ...times,
  };
  const series = seriesTimes(item, occurrence.slot.start, draft, timeZone);
  return {
    asksScope: true,
    this: changed ? [fields, thisOne] : [thisOne],
    all: series === null ? null : [{ ...fields, ...series }],
    clearTopicOverride,
  };
}

/** What a block's rule says, for the sheet's summary. */
export interface RuleSummary {
  frequency: Frequency;
  interval: number;
  /** BYDAY, Sunday first (as the Repeat control shows the week). */
  days: Weekday[];
  count: number | null;
  /** The last day, `YYYY-MM-DD` in the workspace's zone. */
  until: string | null;
}

const WEEK_ORDER: readonly Weekday[] = ['SU', 'MO', 'TU', 'WE', 'TH', 'FR', 'SA'];
const FREQUENCIES: readonly Frequency[] = ['DAILY', 'WEEKLY', 'MONTHLY', 'YEARLY'];

/** The last day of an UNTIL: a UTC time read in the zone, or a date as it is. */
function untilDay(value: string, timeZone: string): string | null {
  const instant = /^(\d{4})(\d{2})(\d{2})T(\d{2})(\d{2})(\d{2})Z$/i.exec(value);
  if (instant !== null) {
    const [, y, mo, d, h, mi, s] = instant.map(Number);
    return dateInZone(
      new Date(Date.UTC(y ?? 0, (mo ?? 1) - 1, d ?? 1, h ?? 0, mi ?? 0, s ?? 0)),
      timeZone,
    );
  }
  const day = /^(\d{4})(\d{2})(\d{2})(?:T\d{6})?$/.exec(value);
  return day === null ? null : `${day[1] ?? ''}-${day[2] ?? ''}-${day[3] ?? ''}`;
}

/** The first RRULE line read for its summary; null without one (or without a frequency). */
export function ruleSummaryOf(recurrence: unknown, timeZone: string): RuleSummary | null {
  const lines = Array.isArray(recurrence) ? (recurrence as unknown[]) : [];
  const line = lines.find(
    (entry): entry is string => typeof entry === 'string' && /^RRULE:/i.test(entry.trim()),
  );
  if (line === undefined) {
    return null;
  }
  const parts = new Map(
    line
      .trim()
      .slice(6)
      .split(';')
      .map((part) => {
        const [key = '', value = ''] = part.split('=');
        return [key.toUpperCase(), value] as const;
      }),
  );
  const frequency = FREQUENCIES.find((entry) => entry === parts.get('FREQ')?.toUpperCase());
  if (frequency === undefined) {
    return null;
  }
  const interval = Number(parts.get('INTERVAL') ?? '1');
  const count = parts.get('COUNT');
  const until = parts.get('UNTIL');
  const days = (parts.get('BYDAY') ?? '').toUpperCase().split(',');
  return {
    frequency,
    interval: Number.isInteger(interval) && interval >= 1 ? interval : 1,
    days: WEEK_ORDER.filter((day) => days.includes(day)),
    count: count !== undefined && /^\d+$/.test(count) ? Number(count) : null,
    until: until === undefined ? null : untilDay(until, timeZone),
  };
}
