/**
 * A time block (docs/superpowers/specs/2026-11-17-time-blocks-design.md): time the member reserves,
 * e.g. "Study: Math, Sundays 13:00–17:00". A local item of kind `block`, optionally Recurring:
 * one record holds the whole series (`props.recurrence`, the RRULE lines, and `props.exceptions`,
 * the occurrences moved or skipped), and its occurrences are computed, never copied
 * (types/recurrence: the expansion the client shares, on the workspace's wall clock).
 *
 * Its subject is its Subject attribute's value (`overlay.attrs.subject`). It is deleted like a
 * to-do (a soft delete, by an editor who sees it) and never completed. Its own edits come with its
 * own routes (Task 5): the generic edit refuses until then.
 */
import type { Caller } from '../base/Caller.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { ItemData } from '../../models/definitions/Item.js';
import { getItemRepository } from '../../models/index.js';
import { SUBJECT_ATTRIBUTE_KEY } from '../../types/attributes.js';
import {
  expandOccurrences,
  isSeriesRow,
  localExceptionsOf,
  type LocalException,
  type Occurrence,
  type Range,
} from '../../types/recurrence/occurrences.js';
import type { BlockLayer } from '../../types/scheduled.js';
import type { Deletable, Recurring } from './contracts.js';
import { Item } from './Item.js';
import { ScheduledItem } from './ScheduledItem.js';

/** The RRULE lines of a props' `recurrence` (the strings in it). */
function recurrenceOf(props: Readonly<Record<string, unknown>>): string[] {
  const lines = props['recurrence'];
  return Array.isArray(lines)
    ? (lines as unknown[]).filter((line): line is string => typeof line === 'string')
    : [];
}

export class TimeBlock extends ScheduledItem implements Recurring, Deletable {
  static {
    Item.register('block', (data) => new TimeBlock(data));
  }

  protected constructor(data: ItemData) {
    super(data);
  }

  /** A plain block; an area is painted time (TimeArea). */
  readonly layer: BlockLayer = 'block';

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
    return recurrenceOf(this.data.props);
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

  /** Until its own routes exist (Task 5), a generic edit is refused. */
  edit(): Promise<Item> {
    return Promise.reject(new ValidationError('edit: use PATCH /time-blocks/:id'));
  }

  /** A soft delete (the purge removes it 30 days later), by an editor who sees it. */
  async delete(caller: Caller): Promise<void> {
    this.assertIn(caller);
    caller.authorize(await ItemPolicy.for(caller), 'manage', this.facts);
    if (!(await (await getItemRepository()).softDelete(this.workspaceId, this.id))) {
      throw new NotFoundError();
    }
  }
}
