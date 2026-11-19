/**
 * Request shapes of the time block routes (zod 4; types/timeBlocks.ts holds the request types).
 * REST and MCP parse with these same schemas, so neither takes what the other refuses. Strict: an
 * unknown key is a 400. What a value means (a real rule, a length from 1 minute to 24 hours, an
 * occurrence of the series) is TimeBlock's to check.
 */
import { z } from 'zod';

import { ValidationError } from '../errors/ValidationError.js';
import { OptionSchema } from '../types/attributes.js';
import { BLOCK_LAYERS } from '../types/scheduled.js';
import { TIME_BLOCK_EDIT_SCOPES } from '../types/timeBlocks.js';

const Iso = z.iso.datetime({ offset: true });
const Title = z.string().trim().min(1).max(300);
const Note = z.string().max(5000);
const Id = z.string().min(1).max(100);
/** An event's `recurrence` shape; RecurrenceRule takes exactly one `RRULE:` line of it (400 else). */
const Recurrence = z.array(z.string().max(500)).min(1).max(5);

export const CreateTimeBlockBody = z.strictObject({
  layer: z.enum(BLOCK_LAYERS).optional(),
  title: Title.optional(),
  subject: OptionSchema.optional(),
  note: Note.optional(),
  topicId: Id.nullable().optional(),
  startAt: Iso,
  endAt: Iso,
  recurrence: Recurrence.optional(),
  idempotencyKey: z.string().min(1).max(200).optional(),
});

/**
 * An edit's fields, before the rules between them (`checkTimeBlockEdit`): EditTimeBlockBody, and
 * the MCP tool's input built on it.
 */
export const EditTimeBlockFields = z.strictObject({
  scope: z.enum(TIME_BLOCK_EDIT_SCOPES),
  originalStart: Iso.optional(),
  title: Title.optional(),
  note: Note.nullable().optional(),
  subject: OptionSchema.nullable().optional(),
  topicId: Id.nullable().optional(),
  startAt: Iso.optional(),
  endAt: Iso.optional(),
  recurrence: Recurrence.nullable().optional(),
});

/**
 * What only an `all` edit changes (plan Ruling 2: "this one" moves an occurrence's times only;
 * its title, subject, topic and rule are the series'). `topic` is the MCP tool's name for it.
 */
const SERIES_FIELDS = ['title', 'note', 'subject', 'topicId', 'topic', 'recurrence'] as const;

/** An edit as the rules between its fields read it (REST's body, or the MCP tool's input). */
interface EditShape {
  scope: (typeof TIME_BLOCK_EDIT_SCOPES)[number];
  /** MCP only: skip the occurrence instead of moving it. */
  skip?: boolean | undefined;
}

/**
 * The rules between an edit's fields: `this` needs `originalStart` and, unless it skips, both new
 * times, and takes nothing of the series; `all` takes no `originalStart` and needs a change.
 */
export function checkTimeBlockEdit(input: EditShape, ctx: z.RefinementCtx): void {
  const fields = input as unknown as Readonly<Record<string, unknown>>;
  const given = (key: string): boolean => fields[key] !== undefined;
  const issue = (path: string, message: string): void => {
    ctx.addIssue({ code: 'custom', path: [path], message });
  };
  if (input.scope === 'this') {
    if (!given('originalStart')) issue('originalStart', 'required to change one occurrence');
    for (const key of SERIES_FIELDS) {
      if (given(key)) issue(key, 'changes every occurrence: use scope all');
    }
    if (input.skip === true) {
      for (const key of ['startAt', 'endAt']) {
        if (given(key)) issue(key, 'a skipped occurrence has no new time');
      }
    } else {
      for (const key of ['startAt', 'endAt']) {
        if (!given(key)) issue(key, 'required to move one occurrence');
      }
    }
    return;
  }
  if (given('originalStart')) issue('originalStart', 'only to change one occurrence (scope this)');
  if (input.skip === true) issue('skip', 'skips one occurrence (scope this)');
  if (![...SERIES_FIELDS, 'startAt', 'endAt'].some(given)) {
    ctx.addIssue({ code: 'custom', path: [], message: 'At least one change is required' });
  }
}

export const EditTimeBlockBody = EditTimeBlockFields.superRefine(checkTimeBlockEdit);

export const SkipOccurrenceBody = z.strictObject({ originalStart: Iso });

/** A time the rules above require here, as a Date (400 naming the field when it is absent). */
export function requiredTime(value: string | undefined, field: string): Date {
  if (value === undefined) throw new ValidationError(`${field}: Required`);
  return new Date(value);
}

/** A time a request may give, as a Date. */
export function optionalTime(value: string | undefined): Date | undefined {
  return value === undefined ? undefined : new Date(value);
}
