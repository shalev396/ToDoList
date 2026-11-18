/**
 * The time block form (time-blocks design, "Creating and filling the week"), as pure functions:
 * what the member filled in, how start, end and length follow one another (any two set the third,
 * `@api-types/timeSpan`), and the `POST …/time-blocks` request it becomes. An area is the same
 * form with `layer: 'area'`, which needs a title.
 *
 * Times are wall-clock fields in the workspace's zone (`YYYY-MM-DD` and `HH:MM`, as the date and
 * time inputs hold them); the length is real minutes.
 */
import type { WeekStart } from '@api-types/recurrence/occurrences.ts';
import type { BlockLayer } from '@api-types/scheduled.ts';
import {
  TIME_BLOCK_MAX_MS,
  TIME_BLOCK_MIN_MS,
  type CreateTimeBlockRequest,
} from '@api-types/timeBlocks.ts';
import {
  derivedField,
  solveSpan,
  touchSpan,
  type Span,
  type SpanField,
} from '@api-types/timeSpan.ts';
import { topicBySlug } from '../../workspaces/topics.ts';
import { dateInZone, instantInZone, timeInZone } from '../zonedDate.ts';
import {
  NO_REPEAT,
  buildRecurrence,
  isRepeating,
  type Repeat,
  type RepeatPreset,
} from './recurrence.ts';

/** What the New sheet creates: a to-do to tick off, a time block, or an area. */
export const NEW_ITEM_KINDS = ['todo', 'block', 'area'] as const;
export type NewItemKind = (typeof NEW_ITEM_KINDS)[number];

/** How the New sheet opens: on a kind, and optionally on a page and with the times filled in. */
export interface NewItemPreset {
  kind: NewItemKind;
  /** A topic id; '' or absent: none chosen. */
  topicId?: string | undefined;
  start?: Date;
  end?: Date;
}

/** A block repeats weekly on chosen days, or by a custom rule (and may end on a date). */
export const BLOCK_REPEAT_PRESETS: readonly RepeatPreset[] = ['none', 'weekly', 'custom'];

export interface TimeBlockFormState {
  layer: BlockLayer;
  title: string;
  subject: string;
  /**
   * The page: a topic id, null for Unsorted, or undefined while none is chosen (the server then
   * takes the page last used with the subject).
   */
  topicId: string | null | undefined;
  startDate: string;
  startTime: string;
  endDate: string;
  endTime: string;
  /** The length in minutes; null while it can't be worked out. */
  minutes: number | null;
  /** The span fields, most recently edited first: the oldest is the one computed. */
  edited: SpanField[];
  repeat: Repeat;
}

/** The span inputs an edit changes. */
export type SpanInputs = Partial<
  Pick<TimeBlockFormState, 'startDate' | 'startTime' | 'endDate' | 'endTime' | 'minutes'>
>;

/** Why the times can't be saved: one of the two kept is empty, the end isn't after the start, … */
export type SpanProblem = 'missing' | 'order' | 'zero' | 'tooLong';
/** Why the name can't be saved: an area needs a title; a block a title or a subject. */
export type TitleProblem = 'areaTitle' | 'titleOrSubject';

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;
const HOUR_MS = 60 * 60_000;

/** `HH:MM` on a `YYYY-MM-DD` date in the zone; null while either isn't a real one. */
function instantOf(date: string, time: string, timeZone: string): Date | null {
  if (!DATE.test(date) || !TIME.test(time)) {
    return null;
  }
  const instant = new Date(instantInZone(date, time, timeZone));
  // 2026-02-31 is not a date: it would come back as another day.
  return dateInZone(instant, timeZone) === date ? instant : null;
}

function spanOf(state: TimeBlockFormState, timeZone: string): Span | null {
  return solveSpan(
    {
      start: instantOf(state.startDate, state.startTime, timeZone),
      end: instantOf(state.endDate, state.endTime, timeZone),
      minutes: state.minutes,
    },
    state.edited,
  );
}

/** The computed field written from the span (cleared while there is none). */
function withDerived(state: TimeBlockFormState, timeZone: string): TimeBlockFormState {
  const span = spanOf(state, timeZone);
  switch (derivedField(state.edited)) {
    case 'minutes':
      return { ...state, minutes: span?.minutes ?? null };
    case 'start':
      return {
        ...state,
        startDate: span === null ? '' : dateInZone(span.start, timeZone),
        startTime: span === null ? '' : timeInZone(span.start, timeZone),
      };
    case 'end':
      return {
        ...state,
        endDate: span === null ? '' : dateInZone(span.end, timeZone),
        endTime: span === null ? '' : timeInZone(span.end, timeZone),
      };
  }
}

/** The next whole hour after `now` on the zone's wall clock. */
function nextHour(now: Date, timeZone: string): Date {
  const hour = Number(timeInZone(now, timeZone).slice(0, 2));
  const today = dateInZone(now, timeZone);
  if (hour < 23) {
    return new Date(instantInZone(today, `${String(hour + 1).padStart(2, '0')}:00`, timeZone));
  }
  const [year = 1970, month = 1, day = 1] = today.split('-').map(Number);
  const tomorrow = new Date(Date.UTC(year, month - 1, day + 1)).toISOString().slice(0, 10);
  return new Date(instantInZone(tomorrow, '00:00', timeZone));
}

/**
 * The page a new block or area starts on (time-blocks design, Decision 5): the preset's, else the
 * topic page it is created from (`t/<slug>`), else none chosen (the server then takes the page last
 * used with the subject). A to-do keeps its own preset.
 */
export function blockTopicOf(
  presetTopicId: string | undefined,
  pageSlug: string | undefined,
  topics: readonly { id: string; slug: string }[],
): string | undefined {
  if (presetTopicId !== undefined && presetTopicId !== '') {
    return presetTopicId;
  }
  return pageSlug === undefined ? undefined : topicBySlug(topics, pageSlug)?.id;
}

/**
 * The form as it opens: the preset's times, else the next whole hour for an hour; the preset's
 * page; no repeat. Start and length stand (the end is computed), so the first edit of the end
 * moves the length and the first edit of the length moves the end, never the start.
 */
export function initialBlockState(
  preset: NewItemPreset,
  now: Date,
  timeZone: string,
): TimeBlockFormState {
  const start = preset.start ?? nextHour(now, timeZone);
  const end = preset.end ?? new Date(start.getTime() + HOUR_MS);
  const state: TimeBlockFormState = {
    layer: preset.kind === 'area' ? 'area' : 'block',
    title: '',
    subject: '',
    topicId: preset.topicId === undefined || preset.topicId === '' ? undefined : preset.topicId,
    startDate: dateInZone(start, timeZone),
    startTime: timeInZone(start, timeZone),
    endDate: dateInZone(end, timeZone),
    endTime: timeInZone(end, timeZone),
    minutes: (end.getTime() - start.getTime()) / 60_000,
    edited: ['start', 'minutes'],
    repeat: NO_REPEAT,
  };
  return withDerived(state, timeZone);
}

/** One of start, end or length was edited: it is now the most recent, and the oldest follows. */
export function editSpan(
  state: TimeBlockFormState,
  field: SpanField,
  inputs: SpanInputs,
  timeZone: string,
): TimeBlockFormState {
  return withDerived({ ...state, ...inputs, edited: touchSpan(state.edited, field) }, timeZone);
}

export function spanProblem(state: TimeBlockFormState, timeZone: string): SpanProblem | null {
  const span = spanOf(state, timeZone);
  if (span !== null) {
    if (span.minutes * 60_000 < TIME_BLOCK_MIN_MS) {
      return 'zero';
    }
    return span.minutes * 60_000 > TIME_BLOCK_MAX_MS ? 'tooLong' : null;
  }
  // No span: the two kept are both readable but make no positive length, or one is missing.
  const kept = (['start', 'end', 'minutes'] as const).filter(
    (field) => field !== derivedField(state.edited),
  );
  const readable = kept.every((field) =>
    field === 'minutes'
      ? state.minutes !== null
      : field === 'start'
        ? instantOf(state.startDate, state.startTime, timeZone) !== null
        : instantOf(state.endDate, state.endTime, timeZone) !== null,
  );
  if (!readable) {
    return 'missing';
  }
  return kept.includes('minutes') ? 'zero' : 'order';
}

export function titleProblem(state: TimeBlockFormState): TitleProblem | null {
  if (state.title.trim() !== '') {
    return null;
  }
  if (state.layer === 'area') {
    return 'areaTitle';
  }
  return state.subject.trim() === '' ? 'titleOrSubject' : null;
}

/**
 * The request to send; null while something can't be sent (titleProblem, spanProblem, or the
 * Repeat control's own problem). A blank title is left out when there is a subject: the server
 * titles the block with the subject as it is stored. The page is sent only once one is chosen.
 * `weekStart` is the workspace's: a rule every N weeks names it (WKST).
 */
export function blockRequestOf(
  state: TimeBlockFormState,
  timeZone: string,
  weekStart: WeekStart = 'sun',
): CreateTimeBlockRequest | null {
  const span = spanOf(state, timeZone);
  if (titleProblem(state) !== null || span === null || spanProblem(state, timeZone) !== null) {
    return null;
  }
  let recurrence: string[] | null = null;
  if (isRepeating(state.repeat)) {
    recurrence = buildRecurrence(state.repeat, {
      dueDate: dateInZone(span.start, timeZone),
      allDay: false,
      timeZone,
      weekStart,
    });
    if (recurrence === null) {
      return null;
    }
  }
  const title = state.title.trim();
  const subject = state.subject.trim();
  return {
    layer: state.layer,
    ...(title === '' ? {} : { title }),
    ...(subject === '' ? {} : { subject }),
    ...(state.topicId === undefined ? {} : { topicId: state.topicId }),
    startAt: span.start.toISOString(),
    endAt: span.end.toISOString(),
    ...(recurrence === null ? {} : { recurrence }),
  };
}
