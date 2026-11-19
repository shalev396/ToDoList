/**
 * TodoList's own reserved time (docs/superpowers/specs/2026-11-17-time-blocks-design.md, "The
 * class model"): a time block or an area the member makes (TimeBlock, TimeArea), or a travel leg
 * TodoList makes for them (TravelLeg). It is an item, so it shows wherever items show, but it is
 * deliberately not a to-do: it is Schedulable (it has a time range) and never Completable, so the
 * compiler refuses to complete one. It has no status to move and nothing of it goes to a provider.
 */
import type { ItemSummary } from '../../types/items.js';
import type { BlockLayer } from '../../types/scheduled.js';
import type { Schedulable } from './contracts.js';
import { Item, type ItemViewContext } from './Item.js';
import type { ProviderHalf } from './ItemEdit.js';
import { ItemEditing } from './ItemEditing.js';
import { TimeRange } from './TimeRange.js';

export abstract class ScheduledItem extends Item implements Schedulable {
  readonly isLocal = true;

  /** A time block's layer (`block` or `area`); null for a travel leg. */
  abstract readonly layer: BlockLayer | null;

  /** When it happens (its first occurrence, for a block that repeats); null without a start. */
  get timeRange(): TimeRange | null {
    return TimeRange.from(this.data.startAt, this.data.endAt, this.data.allDay);
  }

  /** Every field of it is TodoList's own. */
  editing(): Promise<ItemEditing> {
    return Promise.resolve(ItemEditing.local());
  }

  protected get defaultEditing(): ItemEditing {
    return ItemEditing.local();
  }

  /** It has no provider: nothing of an edit goes anywhere but here. */
  providerChanges(): Promise<ProviderHalf> {
    return Promise.resolve({});
  }

  /** As lists show it, with its layer (a time block's; a leg has none). */
  override toSummary(context: ItemViewContext = {}): ItemSummary {
    const layer = this.layer;
    return { ...super.toSummary(context), ...(layer === null ? {} : { layer }) };
  }
}
