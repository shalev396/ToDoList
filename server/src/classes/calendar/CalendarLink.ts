/**
 * One item ↔ Google event mapping of the push (DATA.md §3.15), as the rules about it read it. The
 * phase 5 `Calendar` entity completes it; for now it holds the one rule every delete path shares:
 * which links point at an event TodoList itself made, so only those are ever deleted at Google.
 */
import { eventIdFor } from '../../gcal/diff.js';
import type { CalendarLinkData } from '../../models/definitions/CalendarLink.js';

export class CalendarLink {
  readonly #data: Readonly<CalendarLinkData>;

  private constructor(data: CalendarLinkData) {
    this.#data = Object.freeze({ ...data });
    Object.freeze(this);
  }

  static of(data: CalendarLinkData): CalendarLink {
    return new CalendarLink(data);
  }

  /**
   * Whether a link is a live one to an event TodoList pushed: not tombstoned, `to_google`, and
   * carrying the event id TodoList gives that item (eventIdFor). Only such an event may be
   * deleted at Google (the push's delete and move, an item's delete, a clean-up).
   */
  static isOwnLive(link: CalendarLinkData): boolean {
    return CalendarLink.of(link).isOwnLive;
  }

  get id(): string {
    return this.#data.id;
  }

  get itemId(): string {
    return this.#data.itemId;
  }

  get integrationId(): string {
    return this.#data.integrationId;
  }

  get calendarId(): string {
    return this.#data.calendarId;
  }

  get googleEventId(): string {
    return this.#data.googleEventId;
  }

  get isLive(): boolean {
    return this.#data.tombstonedAt === null;
  }

  /** `to_google`, with the event id TodoList gives the item: an event TodoList made. */
  get isPushedByTodoList(): boolean {
    const { itemId, direction, googleEventId } = this.#data;
    return (
      direction === 'to_google' &&
      typeof itemId === 'string' &&
      itemId !== '' &&
      googleEventId === eventIdFor(itemId)
    );
  }

  get isOwnLive(): boolean {
    return this.isLive && this.isPushedByTodoList;
  }

  toJSON(): CalendarLinkData {
    return { ...this.#data };
  }
}
