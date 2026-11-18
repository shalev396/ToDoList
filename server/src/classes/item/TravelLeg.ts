/**
 * A travel leg (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Object model"): the time
 * TodoList adds to get its member to, from or between the places their day happens in. A local
 * item of kind `travel`, a sibling of TimeBlock under ScheduledItem: never Completable and never
 * Deletable (it is skipped instead: 409 `not_deletable`).
 *
 * A leg is private to its member: stored `visibility: 'private'` and owned by them, and ItemPolicy
 * reads a leg for its owner only, whatever its visibility says (Ruling 8). It takes its topic and
 * subject from the event it serves, so neither is set on the leg itself. What makes it a leg is at
 * `props.travel` (types/travel.ts). Its own edits come with travel storage (Task 11).
 */
import type { Caller } from '../base/Caller.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { ItemData } from '../../models/definitions/Item.js';
import { SUBJECT_ATTRIBUTE_KEY } from '../../types/attributes.js';
import { travelPropsOf, type TravelLegProps } from '../../types/travel.js';
import { Item } from './Item.js';
import type { OverlayEdit } from './Overlay.js';
import { ScheduledItem } from './ScheduledItem.js';

const FROM_ITS_EVENT = 'travel takes it from its event';

export class TravelLeg extends ScheduledItem {
  static {
    Item.register('travel', (data) => new TravelLeg(data));
  }

  private constructor(data: ItemData) {
    super(data);
  }

  /** A leg is no time block: it has no layer. */
  readonly layer = null;

  /** What makes it a leg: its anchor, direction, places by name, mode, length and source. */
  get travel(): TravelLegProps {
    const travel = travelPropsOf(this.data.props);
    if (travel === null) throw new Error(`The travel leg ${this.id} has no travel props`);
    return travel;
  }

  /** Until travel storage exists (Task 11), a generic edit is refused. */
  edit(): Promise<Item> {
    return Promise.reject(new ValidationError('edit: use PATCH /travel/legs/:id'));
  }

  /** TodoList's own fields, but never a topic or a subject of its own (400): its event's apply. */
  override setOverlay(caller: Caller, edit: OverlayEdit): Promise<Item> {
    if (edit.topicOverride !== undefined) {
      return Promise.reject(new ValidationError(`topicOverride: ${FROM_ITS_EVENT}`));
    }
    if (edit.attrs !== undefined && Object.hasOwn(edit.attrs, SUBJECT_ATTRIBUTE_KEY)) {
      return Promise.reject(new ValidationError(`${SUBJECT_ATTRIBUTE_KEY}: ${FROM_ITS_EVENT}`));
    }
    return super.setOverlay(caller, edit);
  }

  /** Custom attribute values, but never a subject of its own (400): its event's applies. */
  override setAttributes(
    caller: Caller,
    values: Readonly<Record<string, unknown>>,
    now: Date = new Date(),
  ): Promise<Item> {
    if (Object.hasOwn(values, SUBJECT_ATTRIBUTE_KEY)) {
      return Promise.reject(new ValidationError(`${SUBJECT_ATTRIBUTE_KEY}: ${FROM_ITS_EVENT}`));
    }
    return super.setAttributes(caller, values, now);
  }
}
