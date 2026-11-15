/**
 * What happens to the push's links when something around them changes outside a push (a push's
 * own links are its Calendar's): right after a to-do is deleted, each event TodoList pushed for it
 * goes at once, through its integration's own write session and checks (deleteLinkedEvent), as
 * that integration's owner (the push is theirs).
 */
import { Actor } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import { Integration, isCalendarProvider } from '../integration/index.js';
import { getCalendarLinkRepository } from '../../models/index.js';
import { logger } from '../../services/logger.js';
import { CalendarLink } from './CalendarLink.js';

export class CalendarLinks {
  readonly #workspaceId: string;

  private constructor(workspaceId: string) {
    this.#workspaceId = workspaceId;
    Object.freeze(this);
  }

  /** The push's links of one workspace. */
  static in(workspaceId: string): CalendarLinks {
    return new CalendarLinks(workspaceId);
  }

  /**
   * A to-do was deleted: each own live link's event is deleted now (claimed first, EventClaim). A
   * link whose integration is read-only, gone, or whose owner left stays (its next push removes the
   * event, once it can); a delete with no answer keeps its claim, which the integration's next push,
   * clean-up or look at its pushed events reconciles once 10 minutes old; any other failure is
   * logged and never fails the delete, which already happened. Returns how many events were
   * deleted.
   */
  async onItemDeleted(itemId: string): Promise<number> {
    const workspaceId = this.#workspaceId;
    let deleted = 0;
    try {
      const links = await (await getCalendarLinkRepository()).listLiveForItem(workspaceId, itemId);
      for (const link of links.filter((entry) => CalendarLink.isOwnLive(entry))) {
        const integration = await Integration.forWorker(link.integrationId);
        if (
          integration?.workspaceId !== workspaceId ||
          !isCalendarProvider(integration) ||
          !integration.allowsWrites
        ) {
          continue;
        }
        const owner = await Caller.enter(workspaceId, Actor.user(integration.ownerUserId));
        if (owner === null) continue;
        try {
          await integration.deleteLinkedEvent(owner, { itemId });
          deleted += 1;
        } catch (error) {
          left(link.integrationId, error);
        }
      }
    } catch (error) {
      left(null, error);
    }
    return deleted;
  }
}

function left(integrationId: string | null, error: unknown): void {
  logger.warn('A deleted to-do’s calendar event was left for a later push or clean-up', {
    integrationId,
    errorName: error instanceof Error ? error.name : typeof error,
  });
}
