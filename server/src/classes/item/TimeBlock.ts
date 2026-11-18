/**
 * A time block (docs/superpowers/specs/2026-11-17-time-blocks-design.md): time the member reserves,
 * e.g. "Study: Math, Sundays 13:00–17:00". A local item of kind `block`, optionally Recurring:
 * one record holds the whole series (`props.recurrence`, one RRULE line, and `props.exceptions`,
 * the occurrences moved or skipped, each keyed by its original start), and its occurrences are
 * computed, never copied (types/recurrence: the expansion the client shares, on the workspace's
 * wall clock). Every save of a series stores when it ends (`props.recurrenceEnd`, null: never), so
 * a query reads a series that ended no more.
 *
 * - `create`: its subject is its Subject attribute's value (`overlay.attrs.subject`), added to the
 *   workspace on first use; its title defaults to the subject; its topic is the one given, else the
 *   one last used with the subject, else none (never the `personal` default of a to-do).
 * - `editOccurrence` ("this one") moves one occurrence's start and end, `skipOccurrence` leaves it
 *   out; `editSeries` ("all") changes the series and drops the exceptions that are no longer its
 *   occurrences (plan Ruling 2). A generic `edit` (`PATCH …/items/:id`) is an "all" edit of title,
 *   note, topic, start and end (Ruling 7).
 * - It lasts from 1 minute to 24 hours, and a series has at most PLAN_LIMITS.timeBlockExceptionsMax
 *   exceptions (Ruling 3).
 *
 * It is changed through the repository's `updateScheduled`, scoped to kind `block` (the to-do path,
 * `updateLocal`, never finds one), with a guard on its `updatedAt`: a change made on a stale read
 * reads again and retries, so two edits at once (two agents skipping two weeks) both stay. It is
 * deleted like a to-do (a soft delete, by an editor who sees it) and never completed.
 */
import type { Caller } from '../base/Caller.js';
import { RecurrenceRule } from '../integration/RecurrenceRule.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { Topic } from '../workspace/Topic.js';
import { Workspace } from '../workspace/Workspace.js';
import { AppError } from '../../errors/AppError.js';
import { NotAnOccurrenceError } from '../../errors/NotAnOccurrenceError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { ItemData, ScheduledItemPatch } from '../../models/definitions/Item.js';
import { getItemRepository } from '../../models/index.js';
import { SUBJECT_ATTRIBUTE_KEY } from '../../types/attributes.js';
import { PLAN_LIMITS } from '../../types/limits.js';
import {
  expandOccurrences,
  isSeriesRow,
  localExceptionsOf,
  recurrenceEndOf,
  type LocalException,
  type Occurrence,
  type Range,
  type TimeRow,
} from '../../types/recurrence/occurrences.js';
import type { BlockLayer } from '../../types/scheduled.js';
import { TIME_BLOCK_MAX_MS, TIME_BLOCK_MIN_MS } from '../../types/timeBlocks.js';
import type { Deletable, Recurring } from './contracts.js';
import { Item } from './Item.js';
import type { EditField, ItemEdit } from './ItemEdit.js';
import { ScheduledItem } from './ScheduledItem.js';
import { TimeRange } from './TimeRange.js';

/** A new block (or area), as callers give it. */
export interface NewTimeBlock {
  layer: BlockLayer;
  /** Default: the subject. An area needs one. */
  title?: string | undefined;
  /** An option of the Subject attribute, matched whatever its case; a new one is added. */
  subject?: string | undefined;
  note?: string | undefined;
  /** A topic of the workspace; null = Unsorted. Default: the one last used with the subject. */
  topicId?: string | null | undefined;
  /** Its first occurrence. */
  startAt: Date;
  endAt: Date;
  /** To repeat: one RRULE line (RecurrenceRule). */
  recurrence?: readonly string[] | undefined;
  idempotencyKey?: string | undefined;
}

/** An "all" edit: every field optional (an absent one does not change). */
export interface SeriesChange {
  title?: string | undefined;
  /** null clears it. */
  note?: string | null | undefined;
  /** null = Unsorted. */
  topicId?: string | null | undefined;
  /** null clears it; a new one is added to the workspace. */
  subject?: string | null | undefined;
  /** The first occurrence's start; alone, the series keeps its length. */
  startAt?: Date | undefined;
  endAt?: Date | undefined;
  /** null: it no longer repeats. */
  recurrence?: readonly string[] | null | undefined;
}

/** One occurrence's new times ("this one"). */
export interface OccurrenceChange {
  startAt: Date;
  endAt: Date;
}

/** What a generic edit (`PATCH …/items/:id`) may change on a block (plan Ruling 7). */
const GENERIC_EDIT_FIELDS: readonly EditField[] = ['title', 'note', 'topicId', 'startAt', 'endAt'];

/** How often a change made on a stale read is read again and retried before a 409. */
const SAVE_ATTEMPTS = 5;

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

const sameLines = (a: readonly string[], b: readonly string[]): boolean =>
  a.length === b.length && a.every((line, index) => line === b[index]);

export class TimeBlock extends ScheduledItem implements Recurring, Deletable {
  static {
    Item.register('block', (data) => new TimeBlock(data));
  }

  protected constructor(data: ItemData) {
    super(data);
  }

  /** A plain block; an area is painted time (TimeArea). */
  readonly layer: BlockLayer = 'block';

  // ─── Making and finding one ───────────────────────────────────────────────

  /**
   * Editors: a new block of the caller's (an area with `layer: 'area'`). `created` is false when
   * the caller already made one with this idempotency key (the unique index on (workspace, owner,
   * key) makes that race-free); a key the caller used for a to-do is a 409.
   */
  static async create(
    caller: Caller,
    input: NewTimeBlock,
  ): Promise<{ block: TimeBlock; created: boolean }> {
    caller.require('editor');
    const span = TimeBlock.#span(input.startAt, input.endAt);
    const lines = input.recurrence === undefined ? null : TimeBlock.#ruleLines(input.recurrence);
    const typed = input.title?.trim() ?? '';
    if (input.layer === 'area' && typed === '') {
      throw new ValidationError('title: an area needs a title');
    }
    if (input.topicId !== undefined && input.topicId !== null) {
      await Topic.assertOf(caller.workspaceId, input.topicId);
    }
    const key = input.idempotencyKey;
    if (key !== undefined) {
      const known = await TimeBlock.#withKey(caller, key);
      if (known !== null) return { block: known, created: false };
    }
    const subject =
      input.subject === undefined ? null : await TimeBlock.#ensureSubject(caller, input.subject);
    const title = typed === '' ? subject : typed;
    if (title === null) throw new ValidationError('title: give a title or a subject');
    const topicId =
      input.topicId !== undefined
        ? input.topicId
        : subject === null
          ? null
          : await TimeBlock.lastTopicForSubject(caller, subject);
    const props = TimeBlock.#propsOf(
      { layer: input.layer, ...(key === undefined ? {} : { idempotencyKey: key }) },
      span,
      lines,
      [],
      caller.settings.timezone,
    );
    let stored: ItemData;
    try {
      stored = await (
        await getItemRepository()
      ).createLocal(caller.workspaceId, {
        ownerUserId: caller.userId,
        title,
        topicId,
        kind: 'block',
        ...(input.note === undefined ? {} : { bodyPreview: input.note }),
        startAt: span.start,
        endAt: span.end,
        allDay: false,
        props,
      });
    } catch (error) {
      if (key === undefined || !isDuplicateKey(error)) throw error;
      const known = await TimeBlock.#withKey(caller, key);
      if (known === null) throw error;
      return { block: known, created: false };
    }
    const block = TimeBlock.#of(Item.from(stored));
    return { block: subject === null ? block : await block.#storeSubject(subject), created: true };
  }

  /** The block (or area) the caller may see, as stored; 404 for anything else. */
  static override async find(caller: Caller, id: string): Promise<TimeBlock> {
    return TimeBlock.#of(await Item.find(caller, id));
  }

  /**
   * The topic of the newest block the caller sees with this subject that has one; null when there
   * is none (no topic is assumed to exist: time-blocks design, Decision 5).
   */
  static async lastTopicForSubject(caller: Caller, subject: string): Promise<string | null> {
    const [row] = await (
      await getItemRepository()
    ).aggregate<{ topicId?: unknown }>(caller.workspaceId, [
      {
        $match: {
          $and: [
            await ItemPolicy.filterFor(caller),
            {
              kind: 'block',
              [`overlay.attrs.${SUBJECT_ATTRIBUTE_KEY}`]: subject,
              topicId: { $type: 'string' },
            },
          ],
        },
      },
      { $sort: { createdAt: -1, _id: -1 } },
      { $limit: 1 },
      { $project: { _id: 0, topicId: 1 } },
    ]);
    return typeof row?.topicId === 'string' ? row.topicId : null;
  }

  // ─── What it is ───────────────────────────────────────────────────────────

  /** Its Subject attribute's value ("Math"); null when it has none. */
  get subject(): string | null {
    const value = this.attributes.get(SUBJECT_ATTRIBUTE_KEY);
    return typeof value === 'string' && value !== '' ? value : null;
  }

  /** Whether it repeats: an RRULE line in its recurrence. */
  get isRecurring(): boolean {
    return isSeriesRow({ props: this.data.props });
  }

  /** Its rule's lines; empty when it doesn't repeat. */
  get recurrenceLines(): readonly string[] {
    const lines = this.data.props['recurrence'];
    return Array.isArray(lines)
      ? (lines as unknown[]).filter((line): line is string => typeof line === 'string')
      : [];
  }

  /** The occurrences moved or skipped, each keyed by its original start. */
  get exceptions(): readonly LocalException[] {
    return localExceptionsOf(this.data.props);
  }

  /** Its occurrences that overlap `range`, on the wall clock of `timeZone` (the workspace's). */
  occurrences(range: Range, timeZone: string): Occurrence[] {
    const { id, kind, title, status, startAt, endAt, dueAt, allDay, source, props } = this.data;
    return expandOccurrences(
      [
        {
          id,
          kind,
          title,
          status,
          startAt,
          endAt,
          dueAt,
          allDay,
          source: {
            provider: source.provider,
            key: source.key,
            url: source.url,
            externalId: source.externalId,
          },
          props: { ...props },
        },
      ],
      range,
      timeZone,
    );
  }

  // ─── Changes ──────────────────────────────────────────────────────────────

  /**
   * "All": editors who see it change the series. A new start alone keeps the length; a new start
   * or rule drops the exceptions that are no longer occurrences of the series; a rule of null
   * makes it a single block (no exceptions). A new subject is added to the workspace.
   */
  async editSeries(caller: Caller, change: SeriesChange): Promise<TimeBlock> {
    await this.#authorize(caller);
    return this.#changeSeries(caller, change);
  }

  /**
   * "This one": the occurrence that starts at `originalStart` (its start before any move) happens
   * at these times instead. 400 `not_an_occurrence` when that is none of the series' occurrences.
   */
  async editOccurrence(
    caller: Caller,
    originalStart: Date,
    change: OccurrenceChange,
  ): Promise<TimeBlock> {
    await this.#authorize(caller);
    const span = TimeBlock.#span(change.startAt, change.endAt);
    return this.#changeOccurrence(caller, originalStart, {
      originalStart: originalStart.toISOString(),
      startAt: span.start.toISOString(),
      endAt: span.end.toISOString(),
    });
  }

  /** One occurrence left out (a move of it is replaced). 400 `not_an_occurrence` as above. */
  async skipOccurrence(caller: Caller, originalStart: Date): Promise<TimeBlock> {
    await this.#authorize(caller);
    return this.#changeOccurrence(caller, originalStart, {
      originalStart: originalStart.toISOString(),
      skipped: true,
    });
  }

  /**
   * A generic edit (`PATCH …/items/:id`): an "all" edit of title, note, topic, start and end; any
   * other field is 400, and so is clearing the title, the start or the end.
   */
  async edit(caller: Caller, edit: ItemEdit): Promise<TimeBlock> {
    await this.#authorize(caller);
    const refused = edit.fields.find((field) => !GENERIC_EDIT_FIELDS.includes(field));
    if (refused !== undefined) {
      throw new ValidationError(
        `${refused}: a time block takes a title, note, topic, start and end (PATCH /time-blocks/:id for its repeat)`,
      );
    }
    const title = edit.get('title');
    const startAt = edit.get('startAt');
    const endAt = edit.get('endAt');
    if (title === null) throw new ValidationError("title: a time block's title can't be cleared");
    if (startAt === null || endAt === null) {
      throw new ValidationError('startAt: a time block keeps its start and end');
    }
    return this.#changeSeries(caller, {
      title,
      note: edit.get('note'),
      topicId: edit.get('topicId'),
      startAt,
      endAt,
    });
  }

  /** A soft delete (the purge removes it 30 days later), by an editor who sees it. */
  async delete(caller: Caller): Promise<void> {
    this.assertIn(caller);
    caller.authorize(await ItemPolicy.for(caller), 'manage', this.facts);
    if (!(await (await getItemRepository()).softDelete(this.workspaceId, this.id))) {
      throw new NotFoundError();
    }
  }

  // ─── Inside ───────────────────────────────────────────────────────────────

  async #changeSeries(caller: Caller, change: SeriesChange): Promise<TimeBlock> {
    const title = change.title?.trim();
    if (title === '') throw new ValidationError('title: Must not be empty');
    if (change.topicId !== undefined && change.topicId !== null) {
      await Topic.assertOf(this.workspaceId, change.topicId);
    }
    const rule =
      change.recurrence === undefined || change.recurrence === null
        ? change.recurrence
        : TimeBlock.#ruleLines(change.recurrence);
    // Its times are checked before a new subject is added to the workspace (and again on the
    // block as it is when saved).
    this.#spanChangedBy(change.startAt, change.endAt);
    const subject =
      change.subject === undefined || change.subject === null
        ? change.subject
        : await TimeBlock.#ensureSubject(caller, change.subject);
    const timeZone = caller.settings.timezone;
    const saved = await this.#save((current) => {
      const span = current.#spanChangedBy(change.startAt, change.endAt);
      const before = current.recurrenceLines;
      const lines = rule === undefined ? (before.length > 0 ? before : null) : rule;
      return {
        ...(title === undefined ? {} : { title }),
        ...(change.note === undefined ? {} : { bodyPreview: change.note }),
        ...(change.topicId === undefined ? {} : { topicId: change.topicId }),
        startAt: span.start,
        endAt: span.end,
        props: TimeBlock.#propsOf(
          current.data.props,
          span,
          lines,
          lines === null ? [] : current.#exceptionsStillIn(span, lines, timeZone),
          timeZone,
        ),
      };
    });
    return subject === undefined || subject === saved.subject
      ? saved
      : saved.#storeSubject(subject);
  }

  async #changeOccurrence(
    caller: Caller,
    originalStart: Date,
    exception: LocalException,
  ): Promise<TimeBlock> {
    const timeZone = caller.settings.timezone;
    const slot = originalStart.getTime();
    return this.#save((current) => {
      const lines = current.recurrenceLines;
      const span = current.timeRange;
      if (span === null || lines.length === 0 || !TimeBlock.#hasSlot(span, lines, slot, timeZone)) {
        throw new NotAnOccurrenceError();
      }
      const others = current.exceptions.filter(
        (entry) => new Date(entry.originalStart).getTime() !== slot,
      );
      const max = PLAN_LIMITS.timeBlockExceptionsMax;
      if (others.length === current.exceptions.length && others.length >= max) {
        throw new ValidationError(
          `exceptions: a series moves or skips at most ${String(max)} occurrences`,
        );
      }
      return {
        props: TimeBlock.#propsOf(
          current.data.props,
          span,
          lines,
          [...others, exception],
          timeZone,
        ),
      };
    });
  }

  /** The edit permission (404 for a block the caller can't see, 403 for a viewer). */
  async #authorize(caller: Caller): Promise<void> {
    this.assertIn(caller);
    caller.authorize(await ItemPolicy.for(caller), 'edit', this.facts);
  }

  /**
   * Writes what `change` makes of the block as last read, guarded by that read's `updatedAt`: when
   * someone changed it in between, it reads again and makes the change on that (409 after
   * SAVE_ATTEMPTS tries). The block as now stored.
   */
  async #save(change: (current: TimeBlock) => ScheduledItemPatch): Promise<TimeBlock> {
    const items = await getItemRepository();
    let reread: TimeBlock | undefined;
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
      const current = reread ?? this;
      const updated = await items.updateScheduled(
        this.workspaceId,
        this.id,
        'block',
        change(current),
        { unchangedSince: current.data.updatedAt },
      );
      if (updated !== null) return TimeBlock.#of(Item.from(updated));
      const stored = await items.findById(this.workspaceId, this.id);
      if (stored === null) throw new NotFoundError();
      reread = TimeBlock.#of(Item.from(stored));
    }
    throw new AppError(409, 'The time block changed while it was saved: try again');
  }

  /** Its subject as now stored (null clears it), in its overlay. */
  async #storeSubject(subject: string | null): Promise<TimeBlock> {
    return TimeBlock.#of(
      await this.storeOverlay({
        attrs: { [SUBJECT_ATTRIBUTE_KEY]: subject },
        editedAt: new Date(),
      }),
    );
  }

  /** Its first occurrence's span after a change of start or end (a new start keeps the length). */
  #spanChangedBy(start: Date | undefined, end: Date | undefined): TimeRange {
    const current = this.timeRange;
    const from = start ?? current?.start;
    const until =
      end ??
      (start === undefined || current === null
        ? current?.end
        : new Date(start.getTime() + current.durationMs));
    if (from === undefined || until === undefined) {
      throw new ValidationError('startAt: a time block needs a start and an end');
    }
    return TimeBlock.#span(from, until);
  }

  /**
   * The exceptions still keyed by an occurrence of the series once it has this span and rule:
   * all of them when neither its start nor its rule changed (its slots are the same).
   */
  #exceptionsStillIn(
    span: TimeRange,
    lines: readonly string[],
    timeZone: string,
  ): LocalException[] {
    const exceptions = [...this.exceptions];
    if (
      span.start.getTime() === this.data.startAt?.getTime() &&
      sameLines(lines, this.recurrenceLines)
    ) {
      return exceptions;
    }
    return exceptions.filter((exception) =>
      TimeBlock.#hasSlot(span, lines, new Date(exception.originalStart).getTime(), timeZone),
    );
  }

  /** The block, as a TimeBlock (a stored block always is one); 404 for any other item. */
  static #of(item: Item): TimeBlock {
    if (!(item instanceof TimeBlock)) throw new NotFoundError();
    return item;
  }

  /** The caller's item made with this idempotency key: null when none; 409 when not a block. */
  static async #withKey(caller: Caller, key: string): Promise<TimeBlock | null> {
    const [existing] = await (
      await getItemRepository()
    ).aggregate(caller.workspaceId, [
      { $match: { ownerUserId: caller.userId, 'props.idempotencyKey': key } },
      { $limit: 1 },
    ]);
    if (existing === undefined) return null;
    const found = Item.fromDoc(existing);
    if (!(found instanceof TimeBlock)) {
      throw new AppError(409, 'idempotencyKey: already used for an item that is not a time block');
    }
    return found;
  }

  /** The workspace's subject for a typed name (Workspace#ensureSubject: added when new). */
  static async #ensureSubject(caller: Caller, name: string): Promise<string> {
    return (await (await Workspace.load(caller)).ensureSubject(caller, name)).subject;
  }

  /** A block's span: it ends after it starts, at least 1 minute and at most 24 hours later. */
  static #span(start: Date, end: Date): TimeRange {
    const span = TimeRange.of(start, end, false);
    if (span.durationMs < TIME_BLOCK_MIN_MS) {
      throw new ValidationError('endAt: a time block lasts at least 1 minute');
    }
    if (span.durationMs > TIME_BLOCK_MAX_MS) {
      throw new ValidationError('endAt: a time block lasts at most 24 hours');
    }
    return span;
  }

  /** The rule's one RRULE line, normalized; 400 for anything RecurrenceRule refuses, or a date UNTIL. */
  static #ruleLines(lines: readonly string[]): string[] {
    const rule = RecurrenceRule.fromLines(lines);
    if (!rule.fits(false)) {
      throw new ValidationError('recurrence: UNTIL must be a UTC time (YYYYMMDDTHHMMSSZ)');
    }
    return [rule.toString()];
  }

  /**
   * Whether `slot` starts one of the occurrences of a series with this span and rule: the shared
   * expansion one millisecond either side of it, with no exception applied.
   */
  static #hasSlot(
    span: TimeRange,
    lines: readonly string[],
    slot: number,
    timeZone: string,
  ): boolean {
    const series: TimeRow = {
      id: 'series',
      kind: 'block',
      title: '',
      status: 'open',
      startAt: span.start,
      endAt: span.end,
      dueAt: null,
      allDay: false,
      source: { provider: 'local', key: null, url: '', externalId: 'series' },
      props: { recurrence: [...lines] },
    };
    return expandOccurrences(
      [series],
      { from: new Date(slot - 1), to: new Date(slot + 1) },
      timeZone,
    ).some((occurrence) => occurrence.originalStart?.getTime() === slot);
  }

  /**
   * A block's props: what `base` holds (its layer, its idempotency key), with its rule, when it
   * ends (a series only) and its exceptions as given.
   */
  static #propsOf(
    base: Readonly<Record<string, unknown>>,
    span: TimeRange,
    lines: readonly string[] | null,
    exceptions: readonly LocalException[],
    timeZone: string,
  ): Record<string, unknown> {
    const props: Record<string, unknown> = Object.fromEntries(
      Object.entries(base).filter(
        ([key]) => key !== 'recurrence' && key !== 'recurrenceEnd' && key !== 'exceptions',
      ),
    );
    if (lines !== null) {
      props['recurrence'] = [...lines];
      props['recurrenceEnd'] = recurrenceEndOf(
        { startAt: span.start, endAt: span.end, props: { recurrence: [...lines], exceptions } },
        timeZone,
      );
    }
    props['exceptions'] = exceptions.map((exception) => ({ ...exception }));
    return props;
  }
}
