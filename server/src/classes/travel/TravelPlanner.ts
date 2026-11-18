/**
 * Travel generation (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Generation and
 * lifecycle"; plan Ruling 12): one member's legs for the whole horizon, today and the
 * TRAVEL_HORIZON_DAYS - 1 days after it in the workspace's zone, made again as one unit (an anchor
 * moved to another day is an update, not a removal and a create).
 *
 * A regeneration gathers the member's anchors (TravelAnchors), plans each day (DayPlanner), works
 * out every trip's length (RouteChain: OpenRouteService when the stage has its key and the
 * workspace's daily quota allows, then the length the member last entered, then the straight
 * line), reconciles the plan with the stored legs (LegReconciler) and writes the result
 * (TravelLeg.applyPlan). It writes only the member's own travel legs (and their geocode cache and
 * the workspace's routing quota): never an anchor, never a provider.
 *
 * Triggers:
 * - an item write of the member's (ItemChanges, subscribed in ./index.ts), for members with travel;
 * - a sync of an integration (sync/worker.ts), for every member with travel in its workspace;
 * - the daily pass (jobs/TravelHorizonPass.ts, from the hourly tick), once a day per member, while
 *   the tick's budget lasts;
 * - rule, place and setting changes (their routes, Task 13).
 *
 * A member who is no longer one (left, removed, or the workspace deleted) gets nothing: their
 * travel is forgotten instead (TravelData.forgetMember), also when they left while it ran.
 */
import { logger } from '../../services/logger.js';
import { TRAVEL_HORIZON_DAYS, TRAVEL_MODES, type TravelMode } from '../../types/travel.js';
import { addLocalDays, startOfZonedDay, wallDate } from '../../types/recurrence/zoned.js';
import { Actor } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import type { TimeBudget } from '../integration/calendar/TimeBudget.js';
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
import { FreeGeocoder } from './geocoding/FreeGeocoder.js';
import { LegReconciler, type AnchorFate } from './LegReconciler.js';
import { Place } from './Place.js';
import { RouteChain } from './routing/RouteChain.js';
import { RoutingQuota } from './RoutingQuota.js';
import { TravelAnchors } from './TravelAnchors.js';
import { TravelData } from './TravelData.js';
import { openRouteServiceKey, travelClient } from './travelHttp.js';
import { TravelProfile } from './TravelProfile.js';
import { TravelRule } from './TravelRule.js';

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
   * ItemChanges' listener: the caller wrote an item, so their legs are made again when they have
   * travel. A member without travel costs one read. A failure is logged and swallowed: it never
   * fails the write. An arrow: it is handed to ItemChanges as it is.
   */
  static readonly onItemChange = async (caller: Caller, change: ItemChange): Promise<void> => {
    if (change.kind === 'travel') return;
    try {
      if (!(await TravelProfile.hasTravelFor(caller))) return;
      await TravelPlanner.regenerate(caller);
    } catch (error) {
      logger.error('travel: regeneration after an item change failed', {
        workspaceId: caller.workspaceId,
        kind: change.kind,
        error,
      });
    }
  };

  /**
   * A sync of this integration ran: every member with travel in its workspace gets their legs made
   * again (its events may have moved, been cancelled or added). One member's failure is logged and
   * the others still run.
   */
  static async afterSync(integrationId: string, now: Date = new Date()): Promise<void> {
    const integration = await Integration.forWorker(integrationId);
    if (integration === null) return;
    const { workspaceId } = integration;
    for (const userId of await TravelProfile.listWithTravelIn(workspaceId)) {
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
   * that failed, logged) wait for the next tick. `done`: those made today by this run.
   */
  static async runDailyPass(
    now: Date,
    budget: TimeBudget,
  ): Promise<{ done: number; left: number }> {
    let done = 0;
    let left = 0;
    for (const member of await TravelProfile.listWithTravel()) {
      const caller = await TravelPlanner.#enter(member.workspaceId, member.userId);
      if (caller === null) continue;
      const today = wallDate(now, caller.settings.timezone);
      if (member.lastPassDay === today) continue;
      if (!budget.canStart()) {
        left += 1;
        continue;
      }
      try {
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
      geocoder: new FreeGeocoder(),
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
    const estimates = await this.#estimates(days, profile, places);
    const planned = days.flatMap((day) => DayPlanner.plan(day, estimates));
    // A leg back after midnight of the last day starts past the horizon: read it too.
    const stored = await TravelLeg.storedFacts(caller, from, addLocalDays(to, 1, timeZone));
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

  /** The length of every trip the days may take, each asked once. */
  async #estimates(
    days: readonly DayPlanInput[],
    profile: TravelProfile,
    places: readonly Place[],
  ): Promise<Map<TripKey, Estimate>> {
    const trips = new Set(days.flatMap((day) => DayPlanner.trips(day)));
    const estimates = new Map<TripKey, Estimate>();
    if (trips.size === 0) return estimates;
    const chain = RouteChain.standard({
      apiKey: await openRouteServiceKey(),
      client: travelClient('openrouteservice'),
      // The workspace's quota of today, in its zone.
      budget: RoutingQuota.for(
        this.#caller.workspaceId,
        wallDate(this.#now, this.#caller.settings.timezone),
      ),
      settings: profile.settings,
      remembered: (fromId, toId, mode) =>
        profile.rememberedMinutes(DayPlanner.tripKey(fromId, toId, mode)),
    });
    const byId = new Map(places.map((place) => [place.id, place]));
    for (const trip of trips) {
      const [fromId, toId, mode] = trip.split('|');
      const start = fromId === undefined ? undefined : byId.get(fromId);
      const end = toId === undefined ? undefined : byId.get(toId);
      if (start === undefined || end === undefined || !isMode(mode)) {
        throw new Error('TravelPlanner: a trip between places the member does not have');
      }
      const estimate = await chain.estimate({
        from: { id: start.id, ...start.coords },
        to: { id: end.id, ...end.coords },
        mode,
      });
      // The straight line always answers: no answer is a broken chain.
      if (estimate === null) throw new Error('TravelPlanner: no length for a trip');
      estimates.set(trip, estimate);
    }
    return estimates;
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
