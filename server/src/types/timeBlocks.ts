/**
 * Time blocks and areas over the API (docs/superpowers/specs/2026-11-17-time-blocks-design.md,
 * "Creating and filling the week"): what the routes take and answer, shared with the client
 * (`@api-types/timeBlocks`). Pure.
 *
 * - A block is created with its first occurrence (start and end) and, to repeat, one RRULE line.
 * - An edit names which occurrences it applies to: `this` changes only the start and end of one
 *   occurrence (an exception keyed by its original start); `all` changes the series (title, note,
 *   subject, topic, times, rule).
 * - A skip leaves one occurrence out. A block is deleted with `DELETE …/items/:id`.
 */
import type { ItemDetail } from './items.js';
import type { BlockLayer } from './scheduled.js';

/** The shortest a block (or one of its occurrences) may last: one minute. */
export const TIME_BLOCK_MIN_MS = 60_000;
/** The longest a block (or one of its occurrences) may last: one day. */
export const TIME_BLOCK_MAX_MS = 24 * 60 * 60_000;

/** Which occurrences an edit applies to: this one (an exception), or all of them (the series). */
export const TIME_BLOCK_EDIT_SCOPES = ['this', 'all'] as const;
export type TimeBlockEditScope = (typeof TIME_BLOCK_EDIT_SCOPES)[number];

/** `POST …/time-blocks`. */
export interface CreateTimeBlockRequest {
  /** `block` (default), or `area`: time painted for a part of life, which needs a title. */
  layer?: BlockLayer;
  /** Default: the subject. */
  title?: string;
  /** An option of the workspace's Subject attribute; a new one is added (the attribute too). */
  subject?: string;
  note?: string;
  /**
   * A topic of the workspace; null = Unsorted. Default: the topic last used with the subject,
   * else none.
   */
  topicId?: string | null;
  /** Its first occurrence (ISO 8601 with an offset). */
  startAt: string;
  endAt: string;
  /** To repeat: one `RRULE:` line, expanded on the workspace's wall clock. */
  recurrence?: string[];
  /** The same key again answers 200 with the block made the first time. */
  idempotencyKey?: string;
}

/** `PATCH …/time-blocks/:id`. */
export interface EditTimeBlockRequest {
  scope: TimeBlockEditScope;
  /** `this` only (required): the occurrence's start before any move. */
  originalStart?: string;
  /** `all` only. */
  title?: string;
  /** `all` only; null clears it. */
  note?: string | null;
  /** `all` only; null clears it. */
  subject?: string | null;
  /** `all` only; null = Unsorted. */
  topicId?: string | null;
  /** `this`: both required (the occurrence's new times). `all`: the series' first occurrence. */
  startAt?: string;
  endAt?: string;
  /** `all` only; null: it no longer repeats. */
  recurrence?: string[] | null;
}

/** `POST …/time-blocks/:id/skip`. */
export interface SkipOccurrenceRequest {
  /** The occurrence's start before any move. */
  originalStart: string;
}

/** Each route answers the block as it is now stored. */
export type TimeBlockResponseData = ItemDetail;
