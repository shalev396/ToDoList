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
 *   up: the link is live again and the next call retries, as before, unless another integration
 *   tracks the event by then (one tracker per event), when the row goes instead;
 * - no answer (a timeout, a 5xx: it may have been made, and may still be landing): `resolve` reads
 *   the event once. Gone or cancelled: settled. Anything else (live, or the read failed or didn't
 *   fit the budget): KEPT, unanswered, never released, because a live reading may come before a
 *   slow DELETE lands. An orphaned event in Google is better than a to-do lost to our own delete.
 * - a claim left unanswered for STUCK_CLAIM_MS is reconciled (`reconcile`) by the integration's
 *   next push (its workspace calendar's integration only: a non-primary push is refused before its
 *   sweep), clean-up (Remove, "Also remove") or look at its pushed events (a small sweep): a read
 *   settles it (gone) or, its call long over, releases it (live). Not every unanswered claim gets
 *   there: a move's claim is erased by its own create half's commit (PERMISSIONS-V2 ruling 12, F
 *   and the move clause), and a claim of an integration nobody visits again is never swept.
 *
 * Used by every TodoList delete of a pushed event: a clean-up step, a to-do's delete
 * (deleteLinkedEvent), a push's delete or move (PushClaims, below: a push's claims together).
 * Internal to the calendar classes: not in any
 * barrel, and syncInternals.test.ts holds that only GoogleCalendarIntegration and PushCommit load
 * it.
 */
import { parseOpId, type WireOp } from '../../gcal/diff.js';
import type { CalendarLinkData } from '../../models/definitions/CalendarLink.js';
import { getCalendarLinkRepository } from '../../models/index.js';
import { logger } from '../../services/logger.js';
import type { TimeBudget } from '../integration/calendar/TimeBudget.js';
import type { OpResult } from '../integration/writers/calendarOps.js';
import { CalendarLink } from './CalendarLink.js';

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

/** Claims one sweep reconciles at most (each a read) in a push or a clean-up. */
export const SWEEP_LIMIT = 20;

/** Claims the sweep of a list of integrations (`pushedEventCount`) reconciles at most. */
export const LIST_SWEEP_LIMIT = 3;

/** What a read of the event says about a DELETE whose answer was lost: made, not made, unknown. */
export type DeleteReading = 'made' | 'not_made' | 'unknown';

/** Where an unanswered DELETE ended: settled (made) or kept (anything else). */
export type ClaimOutcome = 'settled' | 'kept';

/**
 * What one sweep did: claims settled (gone, and the settle written), released (live), kept (a
 * failed read or write).
 */
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

  /**
   * The integration's claims unanswered for STUCK_CLAIM_MS, at most `limit` (SWEEP_LIMIT): the
   * least recently swept first (never swept first), then the oldest, so a claim whose read always
   * fails goes to the back of the line and never starves the rest.
   */
  static async stuck(
    owner: { readonly id: string; readonly workspaceId: string },
    limit: number = SWEEP_LIMIT,
  ): Promise<CalendarLinkData[]> {
    return (await getCalendarLinkRepository()).listUnsettledClaims(
      owner.workspaceId,
      owner.id,
      new Date(Date.now() - STUCK_CLAIM_MS),
      limit,
    );
  }

  /**
   * Stuck claims (`stuck`) reconciled by a read of each event (`read`, which shares one session),
   * while `canGoOn`: gone settles the claim, live releases it (its call is long over), and a read
   * that fails keeps it, then the sweep goes on to the next one. Each attempt stamps the claim's
   * `lastSweptAt` first, which is what `stuck` sorts by, so one bad row never starves the others
   * across sweeps. A failure of one row's own write is logged and kept. The counts are logged
   * (info) when the sweep did anything.
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
      await claim.#swept();
      let reading: DeleteReading;
      try {
        reading = await read(link);
      } catch {
        reading = 'unknown';
      }
      if (reading === 'made') {
        if (await claim.settle()) counts.settled += 1;
        else counts.kept += 1;
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
    const first = stuck[0];
    if (first !== undefined && counts.settled + counts.released + counts.kept > 0) {
      logger.info('Stuck calendar claims reconciled', {
        integrationId: first.integrationId,
        ...counts,
      });
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
   * Whether this call wrote the settle.
   */
  async settle(): Promise<boolean> {
    try {
      return await (
        await getCalendarLinkRepository()
      ).settle(this.#link.workspaceId, this.#link.id, this.#tombstonedAt);
    } catch (error) {
      EventClaim.#logged('settled', error);
      return false;
    }
  }

  /** The sweep is about to read this claim's event: stamped, quietly (it is only an ordering). */
  async #swept(): Promise<void> {
    try {
      await (
        await getCalendarLinkRepository()
      ).markSwept(this.#link.workspaceId, this.#link.id, this.#tombstonedAt);
    } catch (error) {
      EventClaim.#logged('swept', error);
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

  /**
   * Taken back (`release`) for `integrationId`; a failure there is logged, never thrown over the
   * call's own outcome.
   */
  async releaseQuietly(integrationId: string): Promise<void> {
    try {
      await this.release();
    } catch (error) {
      logger.warn('A calendar claim could not be taken back', {
        integrationId,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  static #logged(what: 'settled' | 'released' | 'swept', error: unknown): void {
    logger.warn(`A calendar claim could not be ${what}`, {
      errorName: error instanceof Error ? error.name : typeof error,
    });
  }
}

/** The integration whose push it is: its own links are the ones claimed. */
interface ClaimOwner {
  readonly workspaceId: string;
  readonly id: string;
}

/**
 * One push's claims on its delete ops (GoogleCalendarIntegration#push's collaborator, moved
 * verbatim from the integration), by op id: each delete (or a move's first half) claimed before
 * anything is sent; after the ops, each claimed delete Google gave no answer to read once; then
 * each claim settled, kept or taken back by its op's result. The reads are the push's to make
 * (with its write session's own token), so this module loads no writer.
 */
export class PushClaims {
  readonly #owner: ClaimOwner;
  readonly #claims = new Map<string, EventClaim>();

  constructor(owner: ClaimOwner) {
    this.#owner = owner;
  }

  /** Whether the op `opId` holds a claim (a delete without one is not sent). */
  has(opId: string): boolean {
    return this.#claims.has(opId);
  }

  /**
   * The push's delete ops (a delete, or a move's first half), each claimed on its own live link
   * (EventClaim) before anything is sent: by op id. An op whose link is no longer this
   * integration's own and live on that calendar and event is left out.
   */
  async claimDeletes(ops: readonly WireOp[]): Promise<void> {
    const claims = this.#claims;
    const links = await getCalendarLinkRepository();
    for (const op of ops) {
      const parsed = op.type === 'delete' ? parseOpId(op.opId) : null;
      if (parsed === null) continue;
      const link = await links.findByItem(this.#owner.workspaceId, this.#owner.id, parsed.itemId);
      if (
        link === null ||
        !CalendarLink.isOwnLive(link) ||
        link.calendarId !== op.calendarId ||
        link.googleEventId !== op.eventId
      ) {
        continue;
      }
      const claim = await EventClaim.take(link);
      if (claim !== null) claims.set(op.opId, claim);
    }
  }

  /**
   * Inside the write session, right after the ops: each claimed delete Google gave no answer to
   * (`no_answer`) is read once (`read`: with the session's own token), while a call still fits the
   * budget (no time: unknown). By op id.
   */
  async readLost(
    results: readonly OpResult[],
    budget: TimeBudget,
    read: (claim: EventClaim) => Promise<DeleteReading>,
  ): Promise<Map<string, DeleteReading>> {
    const claims = this.#claims;
    const readings = new Map<string, DeleteReading>();
    for (const result of results) {
      const claim = claims.get(result.opId);
      if (claim === undefined || result.code !== 'no_answer') continue;
      readings.set(result.opId, budget.canStart() ? await read(claim) : 'unknown');
    }
    return readings;
  }

  /**
   * The push's claimed deletes, after the ops: a DELETE Google answered settles its claim; one
   * that got no answer is settled when its read showed it made (and its op then counts as done),
   * and kept otherwise (a live reading may come before a slow DELETE lands: the sweep releases it
   * once STUCK_CLAIM_MS old); any other (deferred, refused, a conflict) takes its claim back.
   */
  async settleDeletes(
    results: readonly OpResult[],
    readings: ReadonlyMap<string, DeleteReading>,
  ): Promise<OpResult[]> {
    const claims = this.#claims;
    const settled: OpResult[] = [];
    for (const result of results) {
      const claim = claims.get(result.opId);
      if (claim === undefined) {
        settled.push(result);
      } else if (result.ok) {
        await claim.settle();
        settled.push(result);
      } else if (result.code === 'no_answer') {
        const reading = readings.get(result.opId) ?? 'unknown';
        const outcome = await claim.resolve(() => Promise.resolve(reading));
        settled.push(outcome === 'settled' ? { opId: result.opId, ok: true } : result);
      } else {
        await claim.releaseQuietly(this.#owner.id);
        settled.push(result);
      }
    }
    return settled;
  }

  /** Nothing was sent (a throw before the ops ran): every claim goes back. */
  async releaseAll(): Promise<void> {
    for (const claim of this.#claims.values()) await claim.releaseQuietly(this.#owner.id);
  }
}
