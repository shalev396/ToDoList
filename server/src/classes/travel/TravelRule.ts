/**
 * A member's travel rule (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Concepts", 3;
 * plan Ruling 11): "when [scope] → travel by [mode], [there / back / both]", optionally to one of
 * their places. Its scope is a where-group (checked like a dashboard query: 400 when it isn't one),
 * every occurrence of one series, or one item or occurrence. Rules are their member's only (another
 * member's rule is a 404); a member keeps at most PLAN_LIMITS.travelRulesPerMember (409
 * `travel_limit`). Changes are for editors and owners.
 *
 * Every change is audited (`travel_rule.create`, `.update`, `.delete`, Ruling 15) with exactly
 * `{ mode, direction, scopeKind }`: never a place, an address, a coordinate or the rule's text.
 * The member's profile notes whether they have travel at all (the daily pass reads that).
 *
 * Marking an item (the spec's "Where travel comes from", 1 and 2) is a rule too: every occurrence
 * of a repeating item is a series rule, one occurrence (or an item that doesn't repeat) an item
 * rule. Marking the same scope again changes its rule, never adds a second one. A mark regenerates
 * the member's legs at once; a length he typed becomes the length of the trips its legs take, and
 * times he typed move its legs as hand edits. An unmark removes the rules and regenerates (their
 * legs go, as no longer matching).
 */
import { parseQuery } from '../../builder/compile.js';
import { QueryValidationError } from '../../builder/errors.js';
import { AppError } from '../../errors/AppError.js';
import { NotAnOccurrenceError } from '../../errors/NotAnOccurrenceError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { TravelRuleData, TravelRulePatch } from '../../models/definitions/TravelRule.js';
import { getTravelRuleRepository } from '../../models/index.js';
import { PLAN_LIMITS } from '../../types/limits.js';
import { seriesHasSlot } from '../../types/recurrence/occurrences.js';
import { addLocalDays, startOfZonedDay } from '../../types/recurrence/zoned.js';
import {
  RULE_DIRECTIONS,
  TRAVEL_HORIZON_DAYS,
  TRAVEL_MODES,
  TRIP_MINUTES_MAX,
  type RuleDirection,
  type SpanInput,
  type TravelDirection,
  type TravelMode,
  type TravelRuleScope,
  type TravelRuleScopeKind,
  type TravelRuleView,
  type WithinArea,
} from '../../types/travel.js';
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, Owned, Viewable } from '../base/contracts.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { AuditLog } from '../AuditLog.js';
import { CalendarEvent, isRecurring, Item, TravelLeg, type LegTimesChange } from '../item/index.js';
import { DayPlanner } from './DayPlanner.js';
import { Place } from './Place.js';
import { TravelAnchors } from './TravelAnchors.js';
import { TravelPlanner } from './TravelPlanner.js';
import { TravelProfile } from './TravelProfile.js';

/** A new rule as callers give it. */
export interface NewTravelRule {
  scope: TravelRuleScope;
  mode: TravelMode;
  direction: RuleDirection;
  /** One of the caller's places; null or absent: the anchor's own place applies. */
  placeId?: string | null | undefined;
}

/** A change to a rule: any of it; what is left out stays as it is. */
export type TravelRuleChange = { [K in keyof NewTravelRule]?: NewTravelRule[K] | undefined };

/** A leg's times as typed when marking (SpanInput), as callers hand them over. */
export type SpanChange = { [K in keyof SpanInput]?: SpanInput[K] | undefined };

/** Travel to (and from) one timed item, as `markItem` takes it. */
export interface MarkItemInput {
  itemId: string;
  /** One occurrence of a repeating item: its original start. */
  occurrence?: Date | undefined;
  /** Every occurrence of a repeating item (a series rule). */
  every: boolean;
  mode: TravelMode;
  direction: RuleDirection;
  /** One of the caller's places; null or absent: the item's own place. */
  placeId?: string | null | undefined;
  /**
   * The leg that gets him there (from Home, or from the place before), as he typed it: `minutes`
   * is how long its trip takes, every time; times move this leg only.
   */
  there?: SpanChange | undefined;
  /** The leg after it (Home, or back into the area around it), as he typed it. */
  back?: SpanChange | undefined;
}

/** Which marks `unmarkItem` takes back: every occurrence's, or one occurrence's (or `single`). */
export interface UnmarkItemInput {
  itemId: string;
  occurrence?: Date | undefined;
  every: boolean;
}

/** A mark's scope: every occurrence of a series, or one item or occurrence. */
type MarkScope = Exclude<TravelRuleScope, { kind: 'where' }>;

/** A span to apply when marking: the legs it changes (by direction), and how. */
interface MarkSpan {
  side: 'there' | 'back';
  directions: readonly TravelDirection[];
  change: LegTimesChange;
}

/** What a mark did with the length typed with it: null when none was typed (MarkItemResponse). */
export type MarkedLength = boolean | null;

const ID_MAX = 200;
const NOT_ITS_OCCURRENCE = 'occurrence: not an occurrence of this item';

/** An item's rule lines: a repeating item's, else none. */
const recurrenceOf = (item: Item): readonly string[] =>
  isRecurring(item) ? item.recurrenceLines : [];

function oneOf<T extends string>(values: readonly T[], value: unknown, field: string): T {
  if (typeof value === 'string' && (values as readonly string[]).includes(value)) return value as T;
  throw new ValidationError(`${field}: one of ${values.join(', ')}`);
}

function itemIdOf(value: unknown): string {
  if (typeof value !== 'string' || value.trim() === '' || value.length > ID_MAX) {
    throw new ValidationError('scope.itemId: an item id');
  }
  return value;
}

/** An occurrence: `single`, or its original start as an ISO instant (stored normalized). */
function occurrenceOf(value: unknown): string {
  if (value === 'single') return value;
  const instant = typeof value === 'string' ? new Date(value) : null;
  if (instant === null || Number.isNaN(instant.getTime())) {
    throw new ValidationError("scope.occurrence: 'single' or the occurrence's original start");
  }
  return instant.toISOString();
}

/** The scope as stored: a where-group the dashboards' compiler takes, or an item reference. */
function scopeOf(scope: TravelRuleScope): TravelRuleScope {
  switch (scope.kind) {
    case 'where':
      try {
        const query = parseQuery({ source: 'items', where: scope.where });
        if (query.where === undefined) throw new ValidationError('scope.where: a rule group');
        return { kind: 'where', where: query.where };
      } catch (error) {
        if (error instanceof QueryValidationError) {
          throw new ValidationError(`scope: ${error.message}`);
        }
        throw error;
      }
    case 'series':
      return { kind: 'series', itemId: itemIdOf(scope.itemId) };
    case 'item':
      return {
        kind: 'item',
        itemId: itemIdOf(scope.itemId),
        occurrence: occurrenceOf(scope.occurrence),
      };
    default:
      throw new ValidationError('scope.kind: one of where, series, item');
  }
}

/** The same scope: kind, item and occurrence (a where-rule is never a mark's). */
function sameMark(a: TravelRuleScope, b: TravelRuleScope): boolean {
  if (a.kind === 'series' && b.kind === 'series') return a.itemId === b.itemId;
  if (a.kind === 'item' && b.kind === 'item') {
    return a.itemId === b.itemId && a.occurrence === b.occurrence;
  }
  return false;
}

/** A typed time, as a Date (400 naming the field when it is none). */
function timeOf(value: string | undefined, field: string): Date | undefined {
  if (value === undefined) return undefined;
  const time = new Date(value);
  if (Number.isNaN(time.getTime())) throw new ValidationError(`${field}: an ISO 8601 time`);
  return time;
}

export class TravelRule
  extends WorkspaceEntity<TravelRuleData>
  implements Owned, Auditable, Viewable<TravelRuleView>
{
  /** The audit action names a rule writes. */
  static readonly Audit = Object.freeze({
    create: 'travel_rule.create',
    update: 'travel_rule.update',
    delete: 'travel_rule.delete',
  });

  private constructor(data: TravelRuleData) {
    super(data);
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** The caller's rules, oldest first (where-rules apply in this order). */
  static async listOwn(caller: Caller): Promise<TravelRule[]> {
    const rows = await (await getTravelRuleRepository()).listOwn(caller.workspaceId, caller.userId);
    return rows.map((row) => new TravelRule(row));
  }

  /** The caller's rule with this id; 404 for anyone else's, or none. */
  static async findOwn(caller: Caller, id: string): Promise<TravelRule> {
    const row = await (
      await getTravelRuleRepository()
    ).findOwn(caller.workspaceId, caller.userId, id);
    if (row === null) throw new NotFoundError();
    return new TravelRule(row);
  }

  get ownerUserId(): string {
    return this.data.ownerUserId;
  }

  isOwnedBy(userId: string): boolean {
    return this.data.ownerUserId === userId;
  }

  get scope(): TravelRuleScope {
    return structuredClone(this.data.scope);
  }

  get scopeKind(): TravelRuleScopeKind {
    return this.data.scope.kind;
  }

  get mode(): TravelMode {
    return this.data.mode;
  }

  get direction(): RuleDirection {
    return this.data.direction;
  }

  /** The place it sends the member to; null: the anchor's own place. */
  get placeId(): string | null {
    return this.data.placeId;
  }

  get createdAt(): Date {
    return this.data.createdAt;
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('travel_rule', this.id);
  }

  /** As its member's own answers show it. */
  toView(): TravelRuleView {
    return {
      id: this.id,
      scope: this.scope,
      mode: this.mode,
      direction: this.direction,
      placeId: this.placeId,
      createdAt: this.createdAt.toISOString(),
    };
  }

  // ─── Changes ──────────────────────────────────────────────────────────────

  /** Editors: a new rule of the caller's (400 for a scope that isn't one; 409 at the cap). */
  static async create(caller: Caller, input: NewTravelRule): Promise<TravelRule> {
    caller.require('editor');
    const scope = scopeOf(input.scope);
    const mode = oneOf(TRAVEL_MODES, input.mode, 'mode');
    const direction = oneOf(RULE_DIRECTIONS, input.direction, 'direction');
    const placeId = input.placeId ?? null;
    if (placeId !== null) await Place.assertOwn(caller, placeId);
    const rules = await getTravelRuleRepository();
    const count = await rules.countOwn(caller.workspaceId, caller.userId);
    if (count >= PLAN_LIMITS.travelRulesPerMember) {
      throw new AppError(409, 'You have the most travel rules allowed: remove one first', {
        code: 'travel_limit',
      });
    }
    const rule = new TravelRule(
      await rules.create(caller.workspaceId, {
        ownerUserId: caller.userId,
        scope,
        mode,
        direction,
        placeId,
      }),
    );
    await TravelProfile.noteRules(caller, true);
    await rule.#audit(caller, TravelRule.Audit.create);
    return rule;
  }

  /** Editors, on their own rule: a new scope, mode, direction or place (null: none). */
  async update(caller: Caller, patch: TravelRuleChange): Promise<TravelRule> {
    this.#authorize(caller);
    const change: TravelRulePatch = {};
    if (patch.scope !== undefined) change.scope = scopeOf(patch.scope);
    if (patch.mode !== undefined) change.mode = oneOf(TRAVEL_MODES, patch.mode, 'mode');
    if (patch.direction !== undefined) {
      change.direction = oneOf(RULE_DIRECTIONS, patch.direction, 'direction');
    }
    if (patch.placeId !== undefined) {
      if (patch.placeId !== null) await Place.assertOwn(caller, patch.placeId);
      change.placeId = patch.placeId;
    }
    const row = await (
      await getTravelRuleRepository()
    ).update(this.workspaceId, this.ownerUserId, this.id, change);
    if (row === null) throw new NotFoundError();
    const rule = new TravelRule(row);
    await rule.#audit(caller, TravelRule.Audit.update);
    return rule;
  }

  /** Editors, on their own rule: it goes. */
  async remove(caller: Caller): Promise<void> {
    this.#authorize(caller);
    const rules = await getTravelRuleRepository();
    if (!(await rules.delete(this.workspaceId, this.ownerUserId, this.id))) {
      throw new NotFoundError();
    }
    const left = await rules.countOwn(this.workspaceId, this.ownerUserId);
    await TravelProfile.noteRules(caller, left > 0);
    await this.#audit(caller, TravelRule.Audit.delete);
  }

  // ─── Marking an item ──────────────────────────────────────────────────────

  /**
   * Editors: travel to (and from) one timed item the caller sees (an event, a to-do with a start, a
   * time block or a painted area), by `mode`, `there`, `back` or both, to `placeId` (else the
   * item's own place). `every` marks every occurrence of a repeating item (a series rule); else one
   * occurrence of it (`occurrence`, its original start), or an item that doesn't repeat (an item
   * rule, `single`). Marking the same again changes that rule.
   *
   * A length he typed (`minutes`) is the trip he named, whether or not the item has legs yet (it
   * may be weeks ahead): `there` is from where he starts (`there.fromPlaceId`, else Home) to where
   * he goes (`placeId`, else the item's own place: its pin, the rule's place, a place its
   * location names, its calendar's default), in `mode`; `back` is that trip reversed. It is set
   * once (TravelProfile#setTripLength: every leg of that trip follows, but the ones he timed by
   * hand; the way back starts with it when it has none), before the legs are made. Never a trip of
   * another place (a leg from the place before is its own trip). `lengthStored` says what became
   * of it: true, false when the item's own place isn't known yet (nothing stored), null when none
   * was typed.
   *
   * Then the member's legs are made again, and times he typed move the item's legs by hand:
   * `there` the leg that gets him to the item (from Home or from the place before), `back` the leg
   * after it (Home, or back into the area around it); his times stand until he resets them. With
   * `every`, a span is a length only. A leg already under way is left as it is. The answer: the
   * rule, the item's live legs in the horizon, by start, and `lengthStored`. With no legs, `within`
   * names the marked area the item is spent in at the area's place, when that is why (a marked
   * area lends its place: the item adds no trips of its own); else null.
   *
   * A moved occurrence of a mirrored series, marked by its own row, is its series' occurrence at its
   * original start (with `every`, its series), as the planner keys its legs.
   *
   * 404: an item the caller can't see. 400: a travel leg, an item with no start, all day or
   * cancelled, a repeating item with neither `every` nor an occurrence, `every` on one that doesn't
   * repeat, a span that isn't one, a `fromPlaceId` or `placeId` not of the caller's; 400
   * `not_an_occurrence` for an occurrence that is none of the item's own (no slot of its series, or
   * an item that doesn't repeat). 409 `travel_home_missing` without a Home (Ruling 24). Nothing is
   * stored when it refuses.
   *
   * Once the rule is stored, a regeneration that fails is logged and the mark still answers
   * (TravelPlanner.afterOwnChange), with the item's legs as they are.
   *
   * `fromPlaceId` is checked to be the caller's own; where a leg starts is the plan's (Home, or
   * the place before), which no per-leg choice changes in this version.
   */
  static async markItem(
    caller: Caller,
    input: MarkItemInput,
  ): Promise<{
    rule: TravelRule;
    legs: TravelLeg[];
    within: WithinArea | null;
    lengthStored: MarkedLength;
  }> {
    caller.require('editor');
    const item = await Item.find(caller, input.itemId);
    const scope = await TravelRule.#markScope(caller, item, input);
    const places = await Place.listOwn(caller);
    const spans = TravelRule.#spans(input, new Set(places.map((place) => place.id)));
    const home = places.find((place) => place.isHome);
    if (home === undefined) {
      throw new AppError(409, 'Set your Home first: every day of travel starts and ends there', {
        code: 'travel_home_missing',
      });
    }
    const choice = {
      mode: input.mode,
      direction: input.direction,
      placeId: input.placeId ?? null,
    };
    const marked = (await TravelRule.listOwn(caller)).find((rule) => sameMark(rule.scope, scope));
    const rule =
      marked === undefined
        ? await TravelRule.create(caller, { scope, ...choice })
        : await marked.update(caller, choice);
    // The length typed is the trip he named, set before the legs are made so they take it.
    const lengthStored = await TravelRule.#setNamedTrips(caller, {
      item,
      itemId: scope.itemId,
      input,
      spans,
      places,
      homeId: home.id,
    });
    // The rule is stored: a regeneration that fails is logged, and the mark answers with the legs
    // there are (the next change, sync or daily pass makes them).
    await TravelPlanner.afterOwnChange(caller, 'mark');
    const now = new Date();
    const answer = async (): Promise<{
      rule: TravelRule;
      legs: TravelLeg[];
      within: WithinArea | null;
      lengthStored: MarkedLength;
    }> => {
      const legs = await TravelRule.#legsOf(caller, scope, now);
      const within =
        legs.length > 0
          ? null
          : await TravelPlanner.areaAround(
              caller,
              {
                itemId: scope.itemId,
                occurrence:
                  scope.kind === 'item' && scope.occurrence !== 'single' ? scope.occurrence : null,
              },
              now,
            );
      return { rule, legs, within, lengthStored };
    };
    for (const { directions, change } of spans) {
      const times = TravelRule.#legTimes(change);
      if (times === null) continue;
      for (const leg of await TravelRule.#legsOf(caller, scope, now)) {
        const travel = leg.travel;
        if (travel === null || !directions.includes(travel.direction)) continue;
        // Under way (or done): history, as a regeneration leaves it.
        if (leg.startAt !== null && leg.startAt < now) continue;
        // His times for this leg only: the length he typed is the named trip's, set above.
        await leg.editTimes(caller, times);
      }
    }
    return answer();
  }

  /**
   * Sets the length typed with a mark for the trip it names (see `markItem`): `there` from his
   * start (else Home) to his place (else the item's own), `back` the same reversed. True when set;
   * false when the item's own place isn't known (or is his start): nothing is stored; null when no
   * length was typed.
   */
  static async #setNamedTrips(
    caller: Caller,
    mark: {
      item: Item;
      itemId: string;
      input: MarkItemInput;
      spans: readonly MarkSpan[];
      places: readonly Place[];
      homeId: string;
    },
  ): Promise<MarkedLength> {
    const typed = mark.spans.flatMap(({ side, change: { minutes } }) =>
      minutes === undefined ? [] : [{ side, minutes }],
    );
    if (typed.length === 0) return null;
    const { item, itemId, input, places } = mark;
    const profile = await TravelProfile.of(caller);
    const origin = input.there?.fromPlaceId ?? mark.homeId;
    const destination =
      input.placeId ??
      TravelAnchors.placeOf(
        { id: item.id, location: item.location, containerId: item.containerId },
        itemId,
        null,
        { places, pins: profile.itemPlaces, defaults: profile.containerPlaces },
      );
    if (destination === null || destination === origin) return false;
    for (const { side, minutes } of typed) {
      const trip =
        side === 'there'
          ? DayPlanner.tripKey(origin, destination, input.mode)
          : DayPlanner.tripKey(destination, origin, input.mode);
      await profile.setTripLength(caller, trip, minutes);
    }
    return true;
  }

  /**
   * A typed span as times for the leg alone: both times; one and the length (the other follows);
   * one alone (the leg keeps its length). Null when no time was typed (a length only).
   */
  static #legTimes(change: LegTimesChange): LegTimesChange | null {
    const { startAt, endAt, minutes } = change;
    const length = minutes === undefined ? null : minutes * 60_000;
    if (startAt !== undefined && endAt !== undefined) return { startAt, endAt };
    if (startAt !== undefined) {
      return length === null
        ? { startAt }
        : { startAt, endAt: new Date(startAt.getTime() + length) };
    }
    if (endAt !== undefined) {
      return length === null ? { endAt } : { startAt: new Date(endAt.getTime() - length), endAt };
    }
    return null;
  }

  /**
   * Editors: travel to an item no more. `every`: the item's series rule and the rules of each of
   * its occurrences; else the rule of one occurrence (`occurrence`) or of the item (`single`).
   * A moved occurrence of a mirrored series names its series' occurrence, as when it was marked.
   * Then the member's legs are made again: the item's go, as no longer matching. 404 when no such
   * mark of the caller's exists (travel a where-rule gives is changed through that rule).
   */
  static async unmarkItem(caller: Caller, input: UnmarkItemInput): Promise<void> {
    caller.require('editor');
    if (input.every && input.occurrence !== undefined) {
      throw new ValidationError('occurrence: every occurrence takes none');
    }
    const target = await TravelRule.#markedItemOf(caller, input.itemId);
    const slot = input.occurrence?.toISOString() ?? target.occurrence ?? 'single';
    const marks = (await TravelRule.listOwn(caller)).filter(({ scope }) =>
      input.every
        ? scope.kind !== 'where' && scope.itemId === target.itemId
        : scope.kind === 'item' && scope.itemId === target.itemId && scope.occurrence === slot,
    );
    if (marks.length === 0) throw new NotFoundError();
    for (const rule of marks) await rule.remove(caller);
    await TravelPlanner.afterOwnChange(caller, 'unmark');
  }

  // ─── Inside ───────────────────────────────────────────────────────────────

  /**
   * What a mark of this item is, keyed as the planner keys its anchors (plan Ruling 9), so a mark
   * that is stored can make a leg: its series, one occurrence of it, or the item itself. A moved
   * occurrence of a mirrored series (Google's exception row) is its series' occurrence at its
   * original start. An occurrence given must be one of the item's own: a slot of its series (the
   * shared expansion, within DST_SLACK_MS), or an exception row's original start; else 400
   * `not_an_occurrence`. A cancelled event gets no travel (400).
   */
  static async #markScope(caller: Caller, item: Item, input: MarkItemInput): Promise<MarkScope> {
    if (item instanceof TravelLeg) throw new ValidationError('itemId: travel is not travelled to');
    if (item.startAt === null) throw new ValidationError('itemId: travel needs a start time');
    if (item.allDay) throw new ValidationError('itemId: an all-day item gets no travel');
    if (item.status === 'cancelled') {
      throw new ValidationError('itemId: a cancelled event gets no travel');
    }
    const given = input.occurrence;
    if (input.every && given !== undefined) {
      throw new ValidationError('occurrence: every occurrence takes none');
    }
    const exception = item instanceof CalendarEvent ? await item.seriesOccurrence(caller) : null;
    if (exception !== null) {
      if (input.every) {
        if (!exception.master) {
          throw new ValidationError('every: the series of this occurrence is not one you see');
        }
        return { kind: 'series', itemId: exception.seriesId };
      }
      if (given !== undefined && given.getTime() !== exception.originalStart.getTime()) {
        throw new NotAnOccurrenceError(NOT_ITS_OCCURRENCE);
      }
      return {
        kind: 'item',
        itemId: exception.seriesId,
        occurrence: exception.originalStart.toISOString(),
      };
    }
    if (input.every) {
      if (!isRecurring(item)) throw new ValidationError('every: the item does not repeat');
      return { kind: 'series', itemId: item.id };
    }
    if (given === undefined) {
      if (isRecurring(item)) {
        throw new ValidationError("occurrence: the occurrence's original start, or every: true");
      }
      return { kind: 'item', itemId: item.id, occurrence: 'single' };
    }
    const series = { startAt: item.startAt, props: { recurrence: [...recurrenceOf(item)] } };
    if (!seriesHasSlot(series, given, caller.settings.timezone)) {
      throw new NotAnOccurrenceError(NOT_ITS_OCCURRENCE);
    }
    return { kind: 'item', itemId: item.id, occurrence: given.toISOString() };
  }

  /**
   * The item a mark of `itemId` is kept under, and the occurrence it names by itself: a moved
   * occurrence of a mirrored series is its series' (at its original start); any other item, or one
   * the caller no longer sees, is its own id.
   */
  static async #markedItemOf(
    caller: Caller,
    itemId: string,
  ): Promise<{ itemId: string; occurrence: string | null }> {
    let item: Item;
    try {
      item = await Item.find(caller, itemId);
    } catch (error) {
      if (error instanceof NotFoundError) return { itemId, occurrence: null };
      throw error;
    }
    const exception = item instanceof CalendarEvent ? await item.seriesOccurrence(caller) : null;
    return exception === null
      ? { itemId, occurrence: null }
      : { itemId: exception.seriesId, occurrence: exception.originalStart.toISOString() };
  }

  /**
   * The spans typed, checked before anything is stored: each a change of the legs it names
   * (`there`: the leg there or from the place before; `back`: the leg after it, Home or back into
   * the area around it): a length (its trip's), times (that leg's), or both. A span that names
   * neither changes nothing.
   */
  static #spans(input: MarkItemInput, placeIds: ReadonlySet<string>): MarkSpan[] {
    const spans: MarkSpan[] = [];
    for (const side of ['there', 'back'] as const) {
      const span = input[side];
      if (span === undefined) continue;
      const from = span.fromPlaceId;
      if (from !== undefined && from !== null && !placeIds.has(from)) {
        throw new ValidationError(`${side}.fromPlaceId: not one of your places`);
      }
      const change: LegTimesChange = {
        startAt: timeOf(span.startAt, `${side}.startAt`),
        endAt: timeOf(span.endAt, `${side}.endAt`),
        minutes: span.minutes,
      };
      const given = Object.values(change).filter((value) => value !== undefined).length;
      if (given === 0) continue;
      if (input.every && (change.startAt !== undefined || change.endAt !== undefined)) {
        throw new ValidationError(`${side}: every occurrence takes a length (minutes) only`);
      }
      const { startAt, endAt, minutes } = change;
      if (startAt !== undefined && endAt !== undefined && endAt <= startAt) {
        throw new ValidationError(`${side}.endAt: travel ends after it starts`);
      }
      if (minutes !== undefined && (!(minutes > 0) || minutes > TRIP_MINUTES_MAX)) {
        throw new ValidationError(`${side}.minutes: more than 0 and at most a day`);
      }
      spans.push({ side, directions: side === 'there' ? ['there', 'between'] : ['back'], change });
    }
    return spans;
  }

  /** The caller's live legs of the marked item (its occurrence's, for one) in the horizon. */
  static async #legsOf(caller: Caller, scope: MarkScope, now: Date): Promise<TravelLeg[]> {
    const zone = caller.settings.timezone;
    const from = startOfZonedDay(now, zone);
    // One day more: a leg home after midnight of the horizon's last day.
    const to = addLocalDays(from, TRAVEL_HORIZON_DAYS + 1, zone);
    const { live } = await TravelLeg.listDays(caller, from, to);
    return live.filter((leg) => {
      const travel = leg.travel;
      return (
        travel !== null &&
        travel.anchorItemId === scope.itemId &&
        (scope.kind === 'series' || travel.occurrence === scope.occurrence)
      );
    });
  }

  /** 404 unless it is the caller's own rule (here); then the editor check (403). */
  #authorize(caller: Caller): void {
    this.assertIn(caller);
    if (!this.isOwnedBy(caller.userId)) throw new NotFoundError();
    caller.require('editor');
  }

  /** The one audit shape of a rule: how and which way, and what kind of scope. Nothing else. */
  async #audit(caller: Caller, action: string): Promise<void> {
    await AuditLog.record(caller, action, this, {
      mode: this.mode,
      direction: this.direction,
      scopeKind: this.scopeKind,
    });
  }
}
