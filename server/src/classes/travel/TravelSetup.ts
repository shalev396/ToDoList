/**
 * A member's travel setup as the API changes it (plan Task 13; the MCP tools take the same doors):
 * their places, rules, settings, default places and pins, and a leg's length, times and reset.
 * Each change is its class's own (Place, TravelRule, TravelProfile, TravelLeg), checked and stored
 * there; what this adds is the spec's trigger "a rule, a place or a setting changes" (plan Ruling
 * 12): the member's legs are made again before the change answers, so the next read agrees with
 * it. A regeneration that fails is logged and never fails the stored change (the next change, a
 * sync or the daily pass makes the legs).
 *
 * Marking an item is TravelRule.markItem, which regenerates itself (its answer holds the legs).
 * Editors and owners only (Ruling 16); everything is the caller's own.
 */
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import {
  LEG_MODE_SCOPES,
  TRAVEL_MODES,
  type LegModeScope,
  type TravelMode,
  type TravelSettingsPatch,
  type TravelSettingsResponse,
} from '../../types/travel.js';
import type { Caller } from '../base/Caller.js';
import { isRecurring, Item } from '../item/index.js';
import { TravelLeg, type LegTimesChange } from '../item/TravelLeg.js';
import { TravelAnchors } from './TravelAnchors.js';
import { Place, type NewPlace, type PlaceChange } from './Place.js';
import { TravelPlanner } from './TravelPlanner.js';
import { TravelProfile } from './TravelProfile.js';
import { TravelRule, type NewTravelRule, type TravelRuleChange } from './TravelRule.js';

export class TravelSetup {
  readonly #caller: Caller;

  private constructor(caller: Caller) {
    this.#caller = caller;
  }

  /** The caller's travel setup: an editor's or owner's (403 otherwise). */
  static of(caller: Caller): TravelSetup {
    caller.require('editor');
    return new TravelSetup(caller);
  }

  // ─── Places ───────────────────────────────────────────────────────────────

  /** A new place (Place.create: a name, and an address for map links if he wants one). */
  async addPlace(input: NewPlace): Promise<Place> {
    const place = await Place.create(this.#caller, input);
    await this.#regenerate('place');
    return place;
  }

  /** One of the caller's places, changed (404 for anyone else's). */
  async changePlace(id: string, patch: PlaceChange): Promise<Place> {
    const caller = this.#caller;
    const place = await (await Place.findOwn(caller, id)).update(caller, patch);
    await this.#regenerate('place');
    return place;
  }

  /** One of the caller's places, removed with everything of theirs that points at it. */
  async removePlace(id: string): Promise<void> {
    const caller = this.#caller;
    await (await Place.findOwn(caller, id)).remove(caller);
    await this.#regenerate('place');
  }

  // ─── Rules ────────────────────────────────────────────────────────────────

  async addRule(input: NewTravelRule): Promise<TravelRule> {
    const rule = await TravelRule.create(this.#caller, input);
    await this.#regenerate('rule');
    return rule;
  }

  /** One of the caller's rules, changed (404 for anyone else's). */
  async changeRule(id: string, patch: TravelRuleChange): Promise<TravelRule> {
    const caller = this.#caller;
    const rule = await (await TravelRule.findOwn(caller, id)).update(caller, patch);
    await this.#regenerate('rule');
    return rule;
  }

  /** One of the caller's rules, removed (its legs go, as no longer matching). */
  async removeRule(id: string): Promise<void> {
    const caller = this.#caller;
    await (await TravelRule.findOwn(caller, id)).remove(caller);
    await this.#regenerate('rule');
  }

  // ─── Settings, default places and pins ────────────────────────────────────

  /** The caller's settings and default places. */
  async settings(): Promise<TravelSettingsResponse> {
    return (await TravelProfile.of(this.#caller)).toSettingsView();
  }

  /** The settings with this change merged in, checked whole (400). */
  async changeSettings(patch: TravelSettingsPatch): Promise<TravelSettingsResponse> {
    const caller = this.#caller;
    const profile = await (await TravelProfile.of(caller)).updateSettings(caller, patch);
    await this.#regenerate('settings');
    return profile.toSettingsView();
  }

  /** A calendar's or project's default place (one of the caller's: 400); null removes it. */
  async setContainerPlace(containerId: string, placeId: string | null): Promise<void> {
    const caller = this.#caller;
    await (await TravelProfile.of(caller)).setContainerPlace(caller, containerId, placeId);
    await this.#regenerate('pin');
  }

  /** An item's place (the spec's "set place"; one of the caller's: 400); null unpins it. */
  async pinItemPlace(itemId: string, placeId: string | null): Promise<void> {
    const caller = this.#caller;
    await (await TravelProfile.of(caller)).pinItemPlace(caller, itemId, placeId);
    await this.#regenerate('pin');
  }

  // ─── Legs ─────────────────────────────────────────────────────────────────

  /**
   * One of the caller's legs, changed (TravelLeg#editTimes; 404 for anyone else's). A length is
   * how long its trip takes, every time: the legs are made again, so every leg of that trip takes
   * it (but the ones whose times he set by hand). Times move this leg only. The leg as it is now.
   */
  async editLeg(id: string, change: LegTimesChange): Promise<TravelLeg> {
    const caller = this.#caller;
    const leg = await (await TravelLeg.findOwn(caller, id)).editTimes(caller, change);
    if (change.minutes === undefined) return leg;
    await this.#regenerate('length');
    return TravelLeg.findOwn(caller, id);
  }

  /**
   * One of the caller's legs back to computed (TravelLeg#reset: a skip undone, his times and the
   * "event moved" flag cleared), then recomputed: the leg as it is now (404 for anyone else's).
   */
  async resetLeg(id: string): Promise<TravelLeg> {
    const caller = this.#caller;
    await (await TravelLeg.findOwn(caller, id)).reset(caller);
    await this.#regenerate('reset');
    return TravelLeg.findOwn(caller, id);
  }

  /**
   * How he goes on one of the caller's legs' events, for `this` day or every `repeats` (the leg's
   * own: 404 for anyone else's, and for one that was removed or skipped: reset it first). The
   * event is marked (TravelRule.markItem) with the rule that makes the leg now (TravelAnchors.ruleOf:
   * its item mark, else its series', else a repeats rule, else the oldest where-rule that matches) keeping that rule's
   * way (`there`, `back`, `both`: a rule that only goes there never gains a trip back) and place
   * (the rule's, else the event's resolved place, else the leg's event side), with the new mode.
   *
   * `this`: that occurrence (an event that doesn't repeat: itself). `repeats`: a repeating event's
   * every occurrence (a series mark); an event that doesn't repeat: it and every later repeat of
   * it, as   * one `repeats` rule (TravelRule.markRepeats: same calendar or project, title, weekday and local
   * start time, from this event on, events imported later too; the same four again change that
   * rule; an item with no calendar or project is just itself), the legs made again once; `marked` is 1 (rules stored). 409 `travel_limit` when it would
   * be past the rule cap (nothing is stored), 404 when the event is no longer one the leg can be made for
   * (moved far, cancelled, no rule asks for it now). `leg`: the leg of the same anchor,
   * occurrence and way after the regeneration; null when none is left.
   */
  async changeLegMode(
    id: string,
    change: { mode: TravelMode; scope: LegModeScope },
  ): Promise<{ marked: number; leg: TravelLeg | null }> {
    const caller = this.#caller;
    if (!(TRAVEL_MODES as readonly string[]).includes(change.mode)) {
      throw new ValidationError(`mode: one of ${TRAVEL_MODES.join(', ')}`);
    }
    if (!(LEG_MODE_SCOPES as readonly string[]).includes(change.scope)) {
      throw new ValidationError(`scope: one of ${LEG_MODE_SCOPES.join(', ')}`);
    }
    const leg = await TravelLeg.findOwn(caller, id);
    const travel = leg.travel;
    if (travel === null || leg.isDeleted) throw new NotFoundError();
    const item = await Item.find(caller, travel.anchorItemId);
    const [profile, rules, places] = await Promise.all([
      TravelProfile.of(caller),
      TravelRule.listOwn(caller),
      Place.listOwn(caller),
    ]);
    const found = await TravelAnchors.ruleOf(
      caller,
      { profile, rules, places, now: new Date() },
      {
        itemId: travel.anchorItemId,
        occurrence: travel.occurrence,
        near: new Date(travel.anchorStart),
      },
    );
    if (found === null) {
      throw new NotFoundError();
    }
    const placeId =
      found.rule.placeId ??
      found.anchor.placeId ??
      (travel.direction === 'back' ? travel.fromPlaceId : travel.toPlaceId);
    const choice = { mode: change.mode, direction: found.rule.direction, placeId };
    const occurrence = travel.occurrence === 'single' ? undefined : new Date(travel.occurrence);
    let marked: number;
    if (change.scope === 'this') {
      await TravelRule.markItem(caller, {
        itemId: travel.anchorItemId,
        occurrence,
        every: false,
        ...choice,
      });
      marked = 1;
    } else if (isRecurring(item) || item.startAt === null) {
      await TravelRule.markItem(caller, {
        itemId: travel.anchorItemId,
        every: true,
        ...choice,
      });
      marked = 1;
    } else if (item.containerId === null) {
      // No calendar or project to find its repeats in (a to-do of his own): just itself.
      await TravelRule.markItem(caller, {
        itemId: travel.anchorItemId,
        occurrence,
        every: false,
        ...choice,
      });
      marked = 1;
    } else {
      // An event that doesn't repeat by itself: one rule for its repeats (later imports too).
      await TravelRule.markRepeats(caller, { itemId: travel.anchorItemId, ...choice });
      marked = 1;
    }
    return { marked, leg: await this.#legNow(leg) };
  }

  // ─── Inside ───────────────────────────────────────────────────────────────

  /** The live leg with the key of `before`, as the regeneration left it; null when none. */
  async #legNow(before: TravelLeg): Promise<TravelLeg | null> {
    const key = before.key;
    const start = before.startAt;
    if (key === null || start === null) return null;
    const day = 24 * 60 * 60 * 1000;
    const { live } = await TravelLeg.listDays(
      this.#caller,
      new Date(start.getTime() - 2 * day),
      new Date(start.getTime() + 2 * day),
    );
    return live.find((one) => one.key === key) ?? null;
  }

  /**
   * The caller's legs over the horizon, made again with what just changed, while the request waits
   * (TravelPlanner.afterOwnChange: a failure is logged, and the stored change still answers).
   */
  async #regenerate(change: string): Promise<void> {
    await TravelPlanner.afterOwnChange(this.#caller, change);
  }
}
