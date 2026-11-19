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
import type { Caller } from '../base/Caller.js';
import { TravelLeg, type LegTimesChange } from '../item/TravelLeg.js';
import type { TravelSettingsPatch, TravelSettingsResponse } from '../../types/travel.js';
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

  // ─── Inside ───────────────────────────────────────────────────────────────

  /**
   * The caller's legs over the horizon, made again with what just changed, while the request waits
   * (TravelPlanner.afterOwnChange: a failure is logged, and the stored change still answers).
   */
  async #regenerate(change: string): Promise<void> {
    await TravelPlanner.afterOwnChange(this.#caller, change);
  }
}
