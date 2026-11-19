/**
 * Who hears of an item write (plan Ruling 17): an observer, so the item classes tell whoever
 * listens without knowing who that is. Todo and TimeBlock notify after each create, update and
 * delete; travel subscribes (classes/travel/index.ts, loaded by classes/index.js) and regenerates
 * the member's legs, with no import from the item classes to travel.
 *
 * `notify` awaits every listener in turn, and a listener that throws is logged and swallowed: a
 * listener's failure never fails the write that was already made.
 */
import type { ItemData } from '../../models/definitions/Item.js';
import { logger } from '../../services/logger.js';
import type { ItemKind } from '../../types/domain.js';
import type { Caller } from '../base/Caller.js';

/**
 * One item written by the caller, as it was (`before`: null when the write made it) and as it is
 * (`after`: null when the write deleted it), so a listener can tell what the write changed.
 */
export interface ItemChange {
  itemId: string;
  kind: ItemKind;
  before: ItemData | null;
  after: ItemData | null;
}

export type ItemChangeListener = (caller: Caller, change: ItemChange) => Promise<void>;

export class ItemChanges {
  /** The process's one registry. */
  static readonly #registry = new ItemChanges();

  readonly #listeners = new Set<ItemChangeListener>();

  private constructor() {
    // One instance: the registry above.
  }

  /** `listener` hears of every item write from now on (once, however often it subscribes). */
  static subscribe(listener: ItemChangeListener): void {
    ItemChanges.#registry.#listeners.add(listener);
  }

  /** `listener` hears of no more writes. */
  static unsubscribe(listener: ItemChangeListener): void {
    ItemChanges.#registry.#listeners.delete(listener);
  }

  static isSubscribed(listener: ItemChangeListener): boolean {
    return ItemChanges.#registry.#listeners.has(listener);
  }

  /** Tells every listener, in turn, of the caller's write; a listener's failure is only logged. */
  static async notify(caller: Caller, change: ItemChange): Promise<void> {
    for (const listener of [...ItemChanges.#registry.#listeners]) {
      try {
        await listener(caller, change);
      } catch (error) {
        logger.error('item change: a listener failed', {
          workspaceId: caller.workspaceId,
          itemId: change.itemId,
          kind: change.kind,
          error,
        });
      }
    }
  }
}
