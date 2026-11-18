/**
 * "Fill any two of start, end and length, and the third is computed" (time-blocks design,
 * "Creating and filling the week"), shared through `@api-types/timeSpan` by every form that sets a
 * span: the time block form, and the travel forms later. Pure.
 *
 * The two kept are the two most recently edited fields; the third, the oldest edit, is worked out
 * from them. The length is in real minutes, so a span on a daylight-saving day keeps its true
 * length; showing the times on the wall clock is the form's job.
 */

export type SpanField = 'start' | 'end' | 'minutes';

export interface SpanFields {
  start: Date | null;
  end: Date | null;
  /** The length, in minutes. */
  minutes: number | null;
}

export interface Span {
  start: Date;
  end: Date;
  minutes: number;
}

/** With fewer than two edits, the pair is filled in this order: start and length make the end. */
const FILL_ORDER: readonly SpanField[] = ['start', 'minutes', 'end'];

const MINUTE_MS = 60_000;

/** The two fields that stand: the two most recent distinct edits, then FILL_ORDER. */
function keptOf(edited: readonly SpanField[]): [SpanField, SpanField] {
  const kept: SpanField[] = [];
  for (const field of [...edited, ...FILL_ORDER]) {
    if (!kept.includes(field)) kept.push(field);
    if (kept.length === 2) break;
  }
  return [kept[0] ?? 'start', kept[1] ?? 'minutes'];
}

/** The field `solveSpan` computes for these edits (most recent first). */
export function derivedField(edited: readonly SpanField[]): SpanField {
  const kept = keptOf(edited);
  return FILL_ORDER.find((field) => !kept.includes(field)) ?? 'end';
}

/** The edit list after `field` was edited: it moves to the front, once. */
export function touchSpan(edited: readonly SpanField[], field: SpanField): SpanField[] {
  return [field, ...edited.filter((entry) => entry !== field)];
}

const readable = (date: Date | null): date is Date =>
  date !== null && !Number.isNaN(date.getTime());

/**
 * The whole span from the two most recently edited fields (`edited[0]`, `edited[1]`, most recent
 * first; a repeat counts once). Null when either of the two is missing or unreadable, or when the
 * length isn't positive (an end at or before the start included). New dates, never the given ones.
 */
export function solveSpan(fields: SpanFields, edited: readonly SpanField[]): Span | null {
  const field = derivedField(edited);
  const { start, end, minutes } = fields;
  let span: Span | null = null;
  if (field === 'end') {
    if (readable(start) && minutes !== null && Number.isFinite(minutes)) {
      span = {
        start: new Date(start),
        end: new Date(start.getTime() + minutes * MINUTE_MS),
        minutes,
      };
    }
  } else if (field === 'start') {
    if (readable(end) && minutes !== null && Number.isFinite(minutes)) {
      span = { start: new Date(end.getTime() - minutes * MINUTE_MS), end: new Date(end), minutes };
    }
  } else if (readable(start) && readable(end)) {
    span = {
      start: new Date(start),
      end: new Date(end),
      minutes: (end.getTime() - start.getTime()) / MINUTE_MS,
    };
  }
  return span !== null && span.minutes > 0 ? span : null;
}
