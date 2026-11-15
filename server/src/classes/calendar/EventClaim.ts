/**
 * TodoList's own delete of an event it pushed, claimed before it is sent (claim before delete):
 * the integration's own live link is tombstoned `dashboard` FIRST, only while it is still live on
 * that calendar, and only then is the Google DELETE sent. So whenever TodoList deletes an event at
 * Google, its tombstone exists for the whole time the delete is in flight:
 * - another integration's commit can never remove the row (removeOthersForEvent takes live rows
 *   only), and it sees the claim (PushCommit: an adopt committed while it stands drops its own
 *   row);
 * - a claim that fails (the row was moved, or another integration adopted the event and removed
 *   it) sends nothing: the event is no longer this integration's to delete.
 *
 * What happens to a claim once the DELETE is out:
 * - Google answered (made, or refused for good): `settle` stamps `deleteAnsweredAt`, the time a
 *   push run must start after for the claim no longer to stand for it (`stands`);
 * - not made (refused for now, deferred, out of time): `release` takes it back: the link is live
 *   again and the next call retries, as before, unless another integration tracks the event by
 *   then (one tracker per event), when the row goes instead;
 * - no answer (a timeout, a 5xx: it may have been made): `resolve` reads the event once. Gone or
 *   cancelled: settled (it was made). Live: released. The read fails too: the claim is KEPT,
 *   unanswered (an orphaned event in Google is better than a to-do lost to our own delete), and
 *   the integration's next push reconciles it (`reconcile`, a claim unanswered for a while).
 *
 * Used by every TodoList delete of a pushed event: a clean-up step, a to-do's delete
 * (deleteLinkedEvent), a push's delete or move. Internal to the calendar classes: not in any
 * barrel, and syncInternals.test.ts holds that only GoogleCalendarIntegration and PushCommit load
 * it.
 */
import type { CalendarLinkData } from '../../models/definitions/CalendarLink.js';
import { getCalendarLinkRepository } from '../../models/index.js';

/**
 * How long before a push run was created an unanswered claim still counts against it: a delete
 * claimed then may still be in flight when the run adopts the event. A Calendar API call gives up
 * after STEP_CEILING_MS (8 s), and a claim whose call got no answer is resolved by a read (or kept)
 * rather than released; a minute covers the call with room, and the clock skew between the Node
 * processes that stamp the run and the claim. An answered claim counts only when its answer came
 * after the run was created.
 */
export const CLAIM_MARGIN_MS = 60 * 1000;

/** What a read of the event says about a DELETE whose answer was lost: made, not made, unknown. */
export type DeleteReading = 'made' | 'not_made' | 'unknown';

/** Where an unanswered DELETE ended: settled (made), released (not made), kept (unknown). */
export type ClaimOutcome = 'settled' | 'released' | 'kept';

export class EventClaim {
  readonly #link: Readonly<CalendarLinkData>;
  /** The claim's own tombstone: every later write of it is conditional on this one. */
  readonly #tombstonedAt: Date;

  private constructor(link: CalendarLinkData, tombstonedAt: Date) {
    this.#link = Object.freeze({ ...link });
    this.#tombstonedAt = new Date(tombstonedAt);
    Object.freeze(this);
  }

  /** Claims `link`'s event for deletion (tombstoned now); null when it is no longer own and live. */
  static async take(link: CalendarLinkData): Promise<EventClaim | null> {
    const claimed = await (
      await getCalendarLinkRepository()
    ).tombstone(link.workspaceId, link.id, 'dashboard', link.calendarId);
    const at = claimed?.tombstonedAt ?? null;
    return claimed === null || at === null ? null : new EventClaim(claimed, at);
  }

  /**
   * Whether `link` is a claim that stands for a push run created at `runCreatedAt`: its DELETE was
   * answered after that, or is unanswered and was claimed at most CLAIM_MARGIN_MS before it.
   */
  static stands(link: CalendarLinkData, runCreatedAt: Date): boolean {
    if (link.deletedBy !== 'dashboard' || link.tombstonedAt === null) return false;
    const run = runCreatedAt.getTime();
    return link.deleteAnsweredAt === null
      ? link.tombstonedAt.getTime() >= run - CLAIM_MARGIN_MS
      : link.deleteAnsweredAt.getTime() >= run;
  }

  /** What `findOthersStanding` takes for a run created at `runCreatedAt` (stands, as a query). */
  static standingSince(runCreatedAt: Date): { answeredSince: Date; claimedSince: Date } {
    return {
      answeredSince: new Date(runCreatedAt),
      claimedSince: new Date(runCreatedAt.getTime() - CLAIM_MARGIN_MS),
    };
  }

  /**
   * The integration's claims unanswered for longer than `olderThanMs` (a process that died, or a
   * read that failed after a lost answer): each `read` and settled, released or kept
   * (`resolve`). How many were settled or released.
   */
  static async reconcile(
    workspaceId: string,
    integrationId: string,
    olderThanMs: number,
    read: (link: CalendarLinkData) => Promise<DeleteReading>,
    canGoOn: () => boolean = () => true,
  ): Promise<number> {
    const links = await getCalendarLinkRepository();
    const stuck = await links.listUnsettledClaims(
      workspaceId,
      integrationId,
      new Date(Date.now() - olderThanMs),
    );
    let done = 0;
    for (const link of stuck) {
      if (!canGoOn() || link.tombstonedAt === null) break;
      const outcome = await new EventClaim(link, link.tombstonedAt).resolve(() => read(link));
      if (outcome !== 'kept') done += 1;
    }
    return done;
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

  /** Google answered the DELETE (made, or refused for good): the claim is settled now. */
  async settle(): Promise<void> {
    await (
      await getCalendarLinkRepository()
    ).settle(this.#link.workspaceId, this.#link.id, this.#tombstonedAt);
  }

  /**
   * The delete was not made: the link is live again (the next call retries), or, when another
   * integration of the workspace tracks the event by now, removed (one tracker per event). Only
   * this very claim is taken back, never a later one of the same row.
   */
  async release(): Promise<void> {
    const links = await getCalendarLinkRepository();
    const { workspaceId, id, integrationId, calendarId, googleEventId } = this.#link;
    const restored = await links.release(workspaceId, id, calendarId, this.#tombstonedAt);
    if (restored === null) return;
    if (await links.hasOtherLive(workspaceId, integrationId, { calendarId, googleEventId })) {
      await links.remove(workspaceId, id);
    }
  }

  /**
   * A DELETE that got no answer, resolved by one read of the event (`read`): made → settled; not
   * made → released; unknown (the read failed too) → kept, unanswered.
   */
  async resolve(read: () => Promise<DeleteReading>): Promise<ClaimOutcome> {
    let reading: DeleteReading;
    try {
      reading = await read();
    } catch {
      reading = 'unknown';
    }
    if (reading === 'made') {
      await this.settle();
      return 'settled';
    }
    if (reading === 'not_made') {
      await this.release();
      return 'released';
    }
    return 'kept';
  }
}
