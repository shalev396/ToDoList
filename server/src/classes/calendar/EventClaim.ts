/**
 * TodoList's own delete of an event it pushed, claimed before it is sent (claim before delete):
 * the integration's own live link is tombstoned `dashboard` FIRST, only while it is still live on
 * that calendar, and only then is the Google DELETE sent. So whenever TodoList deletes an event at
 * Google, its tombstone exists for the whole time the delete is in flight:
 * - another integration's commit can never remove the row (removeOthersForEvent takes live rows
 *   only), and it sees the tombstone (PushCommit: an adopt committed meanwhile drops its own row);
 * - a claim that fails (the row was moved, or another integration adopted the event and removed
 *   it) sends nothing: the event is no longer this integration's to delete.
 *
 * A delete that was not made (refused for now, no answer, out of time) takes its claim back
 * (`release`): the link is live again and the next call retries, as before; unless another
 * integration tracks the event by then (one tracker per event), when the row goes instead.
 *
 * Used by every TodoList delete of a pushed event: a clean-up step, a to-do's delete
 * (deleteLinkedEvent), a push's delete or move.
 */
import type { CalendarLinkData } from '../../models/definitions/CalendarLink.js';
import { getCalendarLinkRepository } from '../../models/index.js';

export class EventClaim {
  readonly #link: Readonly<CalendarLinkData>;

  private constructor(link: CalendarLinkData) {
    this.#link = Object.freeze({ ...link });
    Object.freeze(this);
  }

  /** Claims `link`'s event for deletion (tombstoned now); null when it is no longer own and live. */
  static async take(link: CalendarLinkData): Promise<EventClaim | null> {
    const claimed = await (
      await getCalendarLinkRepository()
    ).tombstone(link.workspaceId, link.id, 'dashboard', link.calendarId);
    return claimed === null ? null : new EventClaim(claimed);
  }

  get linkId(): string {
    return this.#link.id;
  }

  get itemId(): string {
    return this.#link.itemId;
  }

  get calendarId(): string {
    return this.#link.calendarId;
  }

  get googleEventId(): string {
    return this.#link.googleEventId;
  }

  /**
   * The delete was not made: the link is live again (the next call retries), or, when another
   * integration of the workspace tracks the event by now, removed (one tracker per event).
   */
  async release(): Promise<void> {
    const links = await getCalendarLinkRepository();
    const { workspaceId, id, integrationId, calendarId, googleEventId } = this.#link;
    const restored = await links.release(workspaceId, id, calendarId);
    if (restored === null) return;
    if (await links.hasOtherLive(workspaceId, integrationId, { calendarId, googleEventId })) {
      await links.remove(workspaceId, id);
    }
  }
}
