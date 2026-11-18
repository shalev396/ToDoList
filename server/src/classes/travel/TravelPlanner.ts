/**
 * Travel generation (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Generation and
 * lifecycle"; plan Ruling 12): one member's legs for the whole horizon, today and the
 * TRAVEL_HORIZON_DAYS - 1 days after it in the workspace's zone, made again as one unit (an anchor
 * moved to another day is an update, not a removal and a create).
 *
 * A regeneration gathers the member's anchors (TravelAnchors), plans each day (DayPlanner), takes
 * every trip's length from the member's own (TravelProfile#tripLength: the one he set, else
 * UNSET_TRIP_MINUTES, flagged; the owner's decision of 2026-11-18: no routing service, nothing is
 * looked up), reconciles the plan with the stored legs (LegReconciler) and writes the result
 * (TravelLeg.applyPlan). It writes only the member's own travel legs: never an anchor, never a
 * provider, and it never calls out.
 *
 * Triggers:
 * - an item write of the member's (ItemChanges, subscribed in ./index.ts), for members with travel;
 * - a sync of an integration (sync/worker.ts), for every member with travel in its workspace;
 * - the daily pass (jobs/TravelHorizonPass.ts, from the hourly tick), once a day per member, while
 *   the tick's budget lasts;
 * - rule, place, setting and pin changes, a trip's length, a leg's reset (TravelSetup), and marking
 *   or unmarking an item (TravelRule.markItem, unmarkItem), before they answer (`afterOwnChange`: a
 *   failure logged and never the change's).
 *
 * `preview` reads one trip's length the same way, without making a leg.
 *
 * A member who is no longer one (left, removed, or the workspace deleted) gets nothing: their
 * travel is forgotten instead (TravelData.forgetMember), also when they left while it ran.
 *
 * Time: a regeneration is database work only. A sync's members share AFTER_SYNC_BUDGET_MS (no new
 * one starts past it); the daily pass starts members while its own budget lasts.
 */
import { ValidationError } from '../../errors/ValidationError.js';
import type { ItemData } from '../../models/definitions/Item.js';
import { logger } from '../../services/logger.js';
import { stableStringify } from '../../utils/stableStringify.js';
import {
  TRAVEL_HORIZON_DAYS,
  TRAVEL_MODES,
  type TravelMode,
  type TravelPreviewResponse,
} from '../../types/travel.js';
import { addLocalDays, startOfZonedDay, wallDate } from '../../types/recurrence/zoned.js';
import { Actor } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import { STEP_CEILING_MS, TimeBudget } from '../integration/calendar/TimeBudget.js';
import { Integration } from '../integration/index.js';
import type { ItemChange } from '../item/ItemChanges.js';
import { TravelLeg, type AppliedPlan } from '../item/TravelLeg.js';
import {
  DayPlanner,
  type Anchor,
  type DayPlanInput,
  type Estimate,
  type TripKey,
} from './DayPlanner.js';
import { LegReconciler, type AnchorFate } from './LegReconciler.js';
import { Place } from './Place.js';
import { TravelAnchors } from './TravelAnchors.js';
import { TravelData } from './TravelData.js';
import { TravelProfile } from './TravelProfile.js';
import { TravelRule } from './TravelRule.js';

/** Every member's regeneration after one sync, together (the rest wait for the daily pass). */
export const AFTER_SYNC_BUDGET_MS = 60_000;
/**
 * What a sync job keeps of the function's time after its travel: the writes a regeneration makes
 * after its last call out, and the job's own end. Lambda stops the function at 5 minutes, and a
 * job stopped there is run again.
 */
export const AFTER_SYNC_MARGIN_MS = 20_000;

const MINUTE_MS = 60_000;

/** The item fields a leg follows (`movesTravel`; props are compared whole). */
const TRAVEL_FIELDS = [
  'startAt',
  'endAt',
  'allDay',
  'status',
  'topicId',
  'containerId',
  'deletedAt',
] as const satisfies readonly (keyof ItemData)[];

/** A trip to preview (`TravelPlanner.preview`). */
export interface PreviewInput {
  mode: TravelMode;
  /** One of the caller's places; absent: their Home. */
  fromPlaceId?: string | undefined;
  /** One of the caller's places; absent: no length. */
  toPlaceId?: string | undefined;
  arriveBy?: Date | undefined;
  departAt?: Date | undefined;
}

/** What a regeneration that wrote nothing did. */
const NOTHING: Readonly<AppliedPlan> = Object.freeze({ created: 0, updated: 0, removed: 0 });

const isMode = (text: string | undefined): text is TravelMode =>
  (TRAVEL_MODES as readonly (string | undefined)[]).includes(text);

export class TravelPlanner {
  readonly #caller: Caller;
  readonly #now: Date;

  private constructor(caller: Caller, now: Date) {
    this.#caller = caller;
    this.#now = now;
  }

  /** The caller's legs over the horizon from `now`'s day, made again: what was written. */
  static async regenerate(caller: Caller, now: Date = new Date()): Promise<AppliedPlan> {
    return new TravelPlanner(caller, now).#regenerate();
  }

  /**
   * A member's legs made again by the system (a sync, the daily pass), acting for the member. A
   * former member's travel is forgotten instead.
   */
  static async regenerateFor(
    workspaceId: string,
    userId: string,
    now: Date = new Date(),
  ): Promise<AppliedPlan> {
    const caller = await TravelPlanner.#enter(workspaceId, userId);
    return caller === null ? { ...NOTHING } : TravelPlanner.regenerate(caller, now);
  }

  /**
   * ItemChanges' listener: the caller wrote an item in a way a leg can follow (`movesTravel`: its
   * times, status, topic, place or deletion; never a rename or a note), so their legs are made
   * again when they have travel (the request waits). A member without travel costs one read. A
   * failure is logged and swallowed: it never fails the write. An arrow: it is handed to
   * ItemChanges as it is.
   */
  static readonly onItemChange = async (caller: Caller, change: ItemChange): Promise<void> => {
    if (change.kind === 'travel' || !TravelPlanner.movesTravel(change)) return;
    try {
      if (!(await TravelProfile.hasTravelFor(caller))) return;
      await TravelPlanner.regenerate(caller, new Date());
    } catch (error) {
      logger.error('travel: regeneration after an item change failed', {
        workspaceId: caller.workspaceId,
        kind: change.kind,
        error,
      });
    }
  };

  /**
   * Whether a write can change the member's legs: a new or deleted item with a start (one without
   * can never be an anchor); an edit of its start, end, all-day, status, topic (the legs' colour,
   * and a rule may read it), container (its default place), deletion, or props (a location, a
   * repeat, a layer). A rename, a note or a priority leaves the legs as they are; the next sync or
   * daily pass reads the item afresh anyway.
   */
  static movesTravel(change: Pick<ItemChange, 'before' | 'after'>): boolean {
    const { before, after } = change;
    if (before === null || after === null) {
      const item = before ?? after;
      return item !== null && item.startAt !== null;
    }
    return (
      TRAVEL_FIELDS.some(
        (field) => stableStringify(before[field]) !== stableStringify(after[field]),
      ) || stableStringify(before.props) !== stableStringify(after.props)
    );
  }

  /**
   * The member changed their own travel and the change is stored (a place, a rule, a setting, a
   * pin, a trip's length, a mark, a reset: `change` names which): their legs are made again while
   * the request waits. A failure is logged with ids only and swallowed: the change stands and
   * answers as stored, and the next change, sync or daily pass makes the legs. Whether it ran.
   */
  static async afterOwnChange(caller: Caller, change: string): Promise<boolean> {
    try {
      await TravelPlanner.regenerate(caller, new Date());
      return true;
    } catch (error) {
      // Never its message: it may quote what it read.
      logger.error('travel: regeneration after a travel change failed', {
        workspaceId: caller.workspaceId,
        change,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      return false;
    }
  }

  /**
   * The time travel may take after a sync: AFTER_SYNC_BUDGET_MS, but never past `deadline` (epoch
   * ms: when the function is stopped) less AFTER_SYNC_MARGIN_MS. Null when that leaves too little
   * to start one member (STEP_CEILING_MS): travel then waits for the next sync or the daily pass.
   * No deadline (a job run in the process that started it): the whole budget.
   */
  static afterSyncBudget(
    deadline: number | null,
    clock: () => number = Date.now,
  ): TimeBudget | null {
    const ms =
      deadline === null
        ? AFTER_SYNC_BUDGET_MS
        : Math.min(AFTER_SYNC_BUDGET_MS, deadline - clock() - AFTER_SYNC_MARGIN_MS);
    return ms < STEP_CEILING_MS ? null : TimeBudget.start(ms, clock);
  }

  /**
   * A sync of this integration ran: every member with travel in its workspace gets their legs made
   * again (its events may have moved, been cancelled or added), all within `afterSyncBudget` (what
   * the function has left, at most AFTER_SYNC_BUDGET_MS): the members it has no time for wait for
   * the next sync or the daily pass. One member's failure is logged and the others still run.
   */
  static async afterSync(
    integrationId: string,
    now: Date = new Date(),
    options: { deadline?: number | null } = {},
  ): Promise<void> {
    const budget = TravelPlanner.afterSyncBudget(options.deadline ?? null);
    if (budget === null) {
      logger.warn('travel: no time left after a sync', { integrationId });
      return;
    }
    const integration = await Integration.forWorker(integrationId);
    if (integration === null) return;
    const { workspaceId } = integration;
    const members = await TravelProfile.listWithTravelIn(workspaceId);
    for (const [index, userId] of members.entries()) {
      if (!budget.canStart()) {
        logger.warn('travel: no time left after a sync', {
          workspaceId,
          left: members.length - index,
        });
        return;
      }
      try {
        await TravelPlanner.regenerateFor(workspaceId, userId, now);
      } catch (error) {
        logger.error('travel: regeneration after a sync failed', { workspaceId, error });
      }
    }
  }

  /**
   * The daily pass: each member with travel whose legs the pass hasn't made again today (in their
   * workspace's zone) gets them made, while `budget` can start one more; the rest (`left`, and any
   * that failed, logged) wait for the next tick. `done`: those made today by this run. One
   * member's error never stops the pass.
   */
  static async runDailyPass(
    now: Date,
    budget: TimeBudget,
  ): Promise<{ done: number; left: number }> {
    let done = 0;
    let left = 0;
    for (const member of await TravelProfile.listWithTravel()) {
      try {
        const caller = await TravelPlanner.#enter(member.workspaceId, member.userId);
        if (caller === null) continue;
        const today = wallDate(now, caller.settings.timezone);
        if (member.lastPassDay === today) continue;
        if (!budget.canStart()) {
          left += 1;
          continue;
        }
        // Read first: it is never made again for a member who left meanwhile.
        const profile = await TravelProfile.of(caller);
        await TravelPlanner.regenerate(caller, now);
        await profile.markPassed(today);
        done += 1;
      } catch (error) {
        logger.error('travel: the daily pass failed for a member', {
          workspaceId: member.workspaceId,
          error,
        });
        left += 1;
      }
    }
    return { done, left };
  }

  // ─── Inside ───────────────────────────────────────────────────────────────

  async #regenerate(): Promise<AppliedPlan> {
    const caller = this.#caller;
    const now = this.#now;
    const timeZone = caller.settings.timezone;
    const from = startOfZonedDay(now, timeZone);
    const to = addLocalDays(from, TRAVEL_HORIZON_DAYS, timeZone);
    const profile = await TravelProfile.of(caller);
    const places = await Place.listOwn(caller);
    const rules = await TravelRule.listOwn(caller);
    const { anchors, fates } = await TravelAnchors.gather(caller, {
      profile,
      rules,
      places,
      range: { from, to },
      now,
    });
    const homeId = places.find((place) => place.isHome)?.id ?? null;
    const days = this.#days(from, anchors, {
      ownerUserId: caller.userId,
      timeZone,
      now,
      homeId,
      placeNames: new Map(places.map((place) => [place.id, place.name])),
      settings: profile.settings,
    });
    const estimates = TravelPlanner.#lengths(days, profile, places);
    const planned = days.flatMap((day) => DayPlanner.plan(day, estimates));
    // A leg back after midnight of the last day starts past the horizon: read it too. A leg of an
    // anchor that started before the horizon (a leg home after midnight) is not this plan's: it is
    // left as it is, never removed for want of its anchor.
    const stored = (
      await TravelLeg.storedFacts(caller, from, addLocalDays(to, 1, timeZone))
    ).filter((facts) => facts.anchorStart >= from);
    const recon = LegReconciler.reconcile(
      stored,
      planned,
      homeId === null ? TravelPlanner.#homeless(fates) : fates,
      now,
    );
    // They may have left while this ran: nothing of theirs is written (or brought back) then.
    if ((await Caller.enter(caller.workspaceId, Actor.user(caller.userId))) === null) {
      await TravelData.forgetMember(caller.workspaceId, caller.userId);
      return { ...NOTHING };
    }
    return TravelLeg.applyPlan(caller, recon, now);
  }

  /** The horizon's days, each with the anchors that start in it. */
  #days(
    from: Date,
    anchors: readonly Anchor[],
    shared: Omit<DayPlanInput, 'day' | 'anchors'>,
  ): DayPlanInput[] {
    const byDay = new Map<string, Anchor[]>();
    for (const anchor of anchors) {
      const day = wallDate(anchor.start, shared.timeZone);
      byDay.set(day, [...(byDay.get(day) ?? []), anchor]);
    }
    return Array.from({ length: TRAVEL_HORIZON_DAYS }, (_, index) => {
      const day = wallDate(addLocalDays(from, index, shared.timeZone), shared.timeZone);
      return { ...shared, day, anchors: byDay.get(day) ?? [] };
    });
  }

  /**
   * A trip's length as a leg would get it, without making one (the travel panel's live preview):
   * from `fromPlaceId` (default: Home) to `toPlaceId`, by `mode`: the length he set for the trip,
   * else UNSET_TRIP_MINUTES with `lengthUnset`. Without both places there is no length.
   * `arriveBy` ends the trip, `departAt` starts it (not both: 400); the other end follows from the
   * length. 400 for a place that isn't the caller's. Editors (Ruling 16).
   */
  static async preview(caller: Caller, input: PreviewInput): Promise<TravelPreviewResponse> {
    caller.require('editor');
    const { arriveBy, departAt } = input;
    if (arriveBy !== undefined && departAt !== undefined) {
      throw new ValidationError('departAt: give arriveBy or departAt, not both');
    }
    const places = await Place.listOwn(caller);
    const placeOf = (id: string, field: string): Place => {
      const place = places.find((one) => one.id === id);
      if (place === undefined) throw new ValidationError(`${field}: not one of your places`);
      return place;
    };
    const from =
      input.fromPlaceId === undefined
        ? (places.find((place) => place.isHome) ?? null)
        : placeOf(input.fromPlaceId, 'fromPlaceId');
    const to = input.toPlaceId === undefined ? null : placeOf(input.toPlaceId, 'toPlaceId');
    const estimate =
      from === null || to === null
        ? null
        : (await TravelProfile.of(caller)).tripLength(
            DayPlanner.tripKey(from.id, to.id, input.mode),
          );
    const minutes = estimate?.minutes ?? null;
    const shifted = (time: Date, sign: 1 | -1): string | null =>
      minutes === null ? null : new Date(time.getTime() + sign * minutes * MINUTE_MS).toISOString();
    return {
      minutes,
      source: estimate?.source ?? null,
      lengthUnset: estimate?.source === 'unset',
      startAt: departAt?.toISOString() ?? (arriveBy === undefined ? null : shifted(arriveBy, -1)),
      endAt: arriveBy?.toISOString() ?? (departAt === undefined ? null : shifted(departAt, 1)),
    };
  }

  /**
   * The length of every trip the days may take: the member's own for each (or the placeholder of
   * one he hasn't set), the same for every day and every occurrence.
   */
  static #lengths(
    days: readonly DayPlanInput[],
    profile: TravelProfile,
    places: readonly Place[],
  ): Map<TripKey, Estimate> {
    const known = new Set(places.map((place) => place.id));
    const lengths = new Map<TripKey, Estimate>();
    for (const trip of new Set(days.flatMap((day) => DayPlanner.trips(day)))) {
      const [fromId, toId, mode] = trip.split('|');
      if (!known.has(fromId ?? '') || !known.has(toId ?? '') || !isMode(mode)) {
        throw new Error('TravelPlanner: a trip between places the member does not have');
      }
      lengths.set(trip, profile.tripLength(trip));
    }
    return lengths;
  }

  /** Without a Home there are no legs (Ruling 24): the ones that go, go for want of a place. */
  static #homeless(fates: ReadonlyMap<string, AnchorFate>): Map<string, AnchorFate> {
    return new Map(
      [...fates].map(([key, fate]): [string, AnchorFate] => [
        key,
        fate === 'present' ? 'no_place' : fate,
      ]),
    );
  }

  /** The member as a caller, acting for themselves; null (their travel forgotten) for a former one. */
  static async #enter(workspaceId: string, userId: string): Promise<Caller | null> {
    const caller = await Caller.enter(workspaceId, Actor.user(userId));
    if (caller === null) await TravelData.forgetMember(workspaceId, userId);
    return caller;
  }
}
