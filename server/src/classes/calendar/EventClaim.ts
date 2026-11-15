/**
 * TodoList's own delete of an event it pushed, claimed before it is sent (claim before delete):
 * the integration's own live link is tombstoned `dashboard` FIRST, only while it is still live on
 * that calendar, and only then is the Google DELETE sent. So whenever TodoList deletes an event at
 * Google, its tombstone exists for the whole time the delete is in flight:
 * - another integration's commit can never remove the row (removeOthersForEvent takes live rows
 *   only), and it sees the claim (PushCommit: a write committed while it stands drops its own row);
 * - a claim that fails (the row was moved, or another integration adopted the event and removed
 *   it) sends nothing: the event is no longer this integration's to delete.
 *
 * What happens to a claim once the DELETE is out:
 * - Google answered (made, or refused for good): `settle` stamps `deleteAnsweredAt`, the time a
 *   push run must have been created after for the claim no longer to stand for it (`stands`);
 * - not sent, or certainly not made (refused for now, deferred, out of time): `release` takes it
 *   back: the link is live again and the next call retries, as before, unless another integration
 *   tracks the event by then (one tracker per event), when the row goes instead;
 * - no answer (a timeout, a 5xx: it may have been made, and may still be landing): `resolve` reads
 *   the event once. Gone or cancelled: settled. Anything else (live, or the read failed or didn't
 *   fit the budget): KEPT, unanswered, never released, because a live reading may come before a
 *   slow DELETE lands. An orphaned event in Google is better than a to-do lost to our own delete.
 * - a claim left unanswered for STUCK_CLAIM_MS is reconciled (`reconcile`) by the integration's
 *   next push, clean-up (Remove, "Also remove") or look at its pushed events: a read settles it
 *   (gone) or, its call long over, releases it (live).
 *
 * Used by every TodoList delete of a pushed event: a clean-up step, a to-do's delete
 * (deleteLinkedEvent), a push's delete or move. Internal to the calendar classes: not in any
 * barrel, and syncInternals.test.ts holds that only GoogleCalendarIntegration and PushCommit load
 * it.
 */
import type { CalendarLinkData } from '../../models/definitions/CalendarLink.js';
import { getCalendarLinkRepository } from '../../models/index.js';
import { logger } from '../../services/logger.js';

/**
 * How long before a push run was created an unanswered claim still counts against it: a delete
 * claimed then may still be in flight when the run writes the event. A Calendar API call gives up
 * after STEP_CEILING_MS (8 s), and a claim whose call got no answer is settled by a read or kept,
 * never released, until the sweep finds it STUCK_CLAIM_MS old; a minute covers the call with room.
 * It also absorbs the clock skew between the Node processes that stamp the run and the claim, for
 * this branch only: an answered claim counts when its answer is at or after the run's creation,
 * compared exactly.
 */
export const CLAIM_MARGIN_MS = 60 * 1000;

/**
 * A claim unanswered this long is reconciled by a read of its event (and released when the event
 * is live). Over the function's own timeout (5 minutes, infra compute.ts) with room: the request
 * that sent its DELETE is over by then, so no answer of it can still come, and Google applies a
 * request within moments of taking it.
 */
export const STUCK_CLAIM_MS = 10 * 60 * 1000;

/** Claims one sweep reconciles at most (each a read), the oldest first. */
export const SWEEP_LIMIT = 20;

/** What a read of the event says about a DELETE whose answer was lost: made, not made, unknown. */
export type DeleteReading = 'made' | 'not_made' | 'unknown';

/** Where an unanswered DELETE ended: settled (made) or kept (anything else). */
export type ClaimOutcome = 'settled' | 'kept';

/** What one sweep did: claims settled (gone), released (live), kept (a failed read, no time). */
export interface SweepCounts {
  settled: number;
  released: number;
  kept: number;
}

export class EventClaim {
  readonly #link: Readonly<CalendarLinkData>;
  /** The claim's own tombstone: every later write of it is conditional on this one. */
  readonly #tombstonedAt: Date;

  private constructor(link: CalendarLinkData, tombstonedAt: Date) {
    this.#link = Object.freeze({ ...link });
    this.#tombstonedAt = new Date(tombstonedAt);
    Object.freeze(this);
  }

  /** Claims `link`'s event for deletion (tombstoned now); null when no longer own and live. */
  static async take(link: CalendarLinkData): Promise<EventClaim | null> {
    const claimed = await (
      await getCalendarLinkRepository()
    ).tombstone(link.workspaceId, link.id, 'dashboard', link.calendarId);
    const at = claimed?.tombstonedAt ?? null;
    return claimed === null || at === null ? null : new EventClaim(claimed, at);
  }

  /**
   * Whether `link` is a claim that stands for a push run created at `runCreatedAt`: its DELETE was
   * answered at or after that, or is unanswered and was claimed at most CLAIM_MARGIN_MS before it.
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

  /** The integration's claims unanswered for STUCK_CLAIM_MS, oldest first, at most SWEEP_LIMIT. */
  static async stuck(owner: {
    readonly id: string;
    readonly workspaceId: string;
  }): Promise<CalendarLinkData[]> {
    return (await getCalendarLinkRepository()).listUnsettledClaims(
      owner.workspaceId,
      owner.id,
      new Date(Date.now() - STUCK_CLAIM_MS),
      SWEEP_LIMIT,
    );
  }

  /**
   * Stuck claims (`stuck`) reconciled by a read of each event (`read`, which shares one session),
   * while `canGoOn`: gone settles the claim, live releases it (its call is long over), and a read
   * that fails keeps it, then the sweep goes on to the next one (one bad row never starves the
   * others). A failure of one row's own write is logged and kept.
   */
  static async reconcile(
    stuck: readonly CalendarLinkData[],
    read: (link: CalendarLinkData) => Promise<DeleteReading>,
    canGoOn: () => boolean = () => true,
  ): Promise<SweepCounts> {
    const counts: SweepCounts = { settled: 0, released: 0, kept: 0 };
    for (const link of stuck) {
      if (!canGoOn() || link.tombstonedAt === null) break;
      const claim = new EventClaim(link, link.tombstonedAt);
      let reading: DeleteReading;
      try {
        reading = await read(link);
      } catch {
        reading = 'unknown';
      }
      if (reading === 'made') {
        await claim.settle();
        counts.settled += 1;
      } else if (reading === 'not_made') {
        try {
          await claim.release();
          counts.released += 1;
        } catch (error) {
          EventClaim.#logged('released', error);
          counts.kept += 1;
        }
      } else {
        counts.kept += 1;
      }
    }
    return counts;
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
   * Google answered the DELETE (made, or refused for good): the claim is settled now. A failure is
   * logged, never thrown: the claim then stays unanswered, for the sweep, which is the safe side.
   */
  async settle(): Promise<void> {
    try {
      await (
        await getCalendarLinkRepository()
      ).settle(this.#link.workspaceId, this.#link.id, this.#tombstonedAt);
    } catch (error) {
      EventClaim.#logged('settled', error);
    }
  }

  /**
   * The delete was not sent, or certainly not made: the link is live again (the next call
   * retries), or, when another integration of the workspace tracks the event by now, removed (one
   * tracker per event). Only this very claim, still unanswered, is taken back.
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
   * A DELETE that got no answer, resolved by one read of the event (`read`): made → settled;
   * anything else → kept, unanswered (a live reading may come before a slow DELETE lands; the
   * sweep releases it once it is STUCK_CLAIM_MS old). Never throws.
   */
  async resolve(read: () => Promise<DeleteReading>): Promise<ClaimOutcome> {
    let reading: DeleteReading;
    try {
      reading = await read();
    } catch {
      reading = 'unknown';
    }
    if (reading !== 'made') return 'kept';
    await this.settle();
    return 'settled';
  }

  static #logged(what: 'settled' | 'released', error: unknown): void {
    logger.warn(`A calendar claim could not be ${what}`, {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}
