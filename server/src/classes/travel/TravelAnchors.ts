/**
 * A member's anchors for a range of days (docs/superpowers/specs/2026-11-17-travel-time-design.md,
 * "The day plan", 1; "Concepts", 2 and 3; plan Rulings 9 and 11): the timed occurrences they
 * travel to, each with its place and the rule that asks for travel; and what became of every
 * occurrence the range holds (its fate), so a leg that goes says why.
 *
 * - Rows: what the member may read, as a calendar reads it (ItemQuery#runDraft, `blockType:
 *   'calendar'`, so a series that began weeks ago is read too): a start, any kind but travel, in
 *   the range, at most ANCHOR_ROWS_MAX. Series are expanded on the workspace's wall clock; all-day
 *   and due-only occurrences never anchor.
 * - Rule (Ruling 11): the item rule of that occurrence, else the series rule of its series, else
 *   the oldest where-rule that matches (each where-rule is its own draft, ANDed with the range).
 * - Place, in order: the member's pin of the item; the rule's place; a place named (or aliased) in
 *   the event's location; the location geocoded (cached per member by the text's hash; at most
 *   NEW_GEOCODES_MAX new lookups per gather) to a place within PLACE_MATCH_RADIUS_M; the default
 *   place of its calendar or project. Otherwise none, and no travel.
 * - An occurrence is anchored by its series (`seriesRowId`, a moved Google occurrence's master) or
 *   its own row, and by its ORIGINAL start (`single` for an item that doesn't repeat).
 *
 * Read-only: it reads items and writes nothing but the member's own geocode cache.
 */
import { QueryValidationError } from '../../builder/errors.js';
import { logger } from '../../services/logger.js';
import type { ItemQueryRow, Query, RuleGroup } from '../../types/builder.js';
import {
  expandOccurrences,
  isSeriesRow,
  localExceptionsOf,
  toDate,
  type Occurrence,
  type Range,
} from '../../types/recurrence/occurrences.js';
import { PLACE_MATCH_RADIUS_M, type TravelRuleScope } from '../../types/travel.js';
import type { Caller } from '../base/Caller.js';
import { ItemQuery } from '../item/ItemQuery.js';
import type { Anchor } from './DayPlanner.js';
import { nearestWithin, type LatLon } from './geo.js';
import { parseCoordinates, type Geocoder } from './geocoding/Geocoder.js';
import type { AnchorFate } from './LegReconciler.js';
import type { Place } from './Place.js';
import { PlaceMatcher } from './PlaceMatcher.js';
import type { TravelProfile } from './TravelProfile.js';
import type { TravelRule } from './TravelRule.js';

/** The most rows one draft reads: a member's timed items over the horizon (a series is one). */
export const ANCHOR_ROWS_MAX = 1000;
/** New geocoder lookups per gather (each Nominatim one takes a second). */
export const NEW_GEOCODES_MAX = 10;

export interface GatherInput {
  profile: TravelProfile;
  rules: readonly TravelRule[];
  places: readonly Place[];
  range: Range;
  now: Date;
  geocoder: Geocoder;
}

export interface Gathered {
  anchors: Anchor[];
  /** By `anchorItemId|occurrence` (LegKey#anchorKey). */
  fates: Map<string, AnchorFate>;
}

/** A rule with its scope read once. */
interface Scoped {
  rule: TravelRule;
  scope: TravelRuleScope;
}

/** Which fate wins when one occurrence gets two: what is there now beats what was. */
const FATE_RANK: Readonly<Record<AnchorFate, number>> = {
  cancelled: 0,
  moved: 1,
  no_longer_matches: 2,
  no_place: 3,
  present: 4,
};

/** What every anchor row is: it has a start, and it is no travel leg. */
const ANCHOR_RULES: RuleGroup = {
  combinator: 'and',
  rules: [
    { field: 'startAt', operator: 'notNull' },
    { field: 'kind', operator: '!=', value: 'travel' },
  ],
};

const anchorKey = (itemId: string, occurrence: string): string => `${itemId}|${occurrence}`;

/** A Google series' key, `calendarId|eventId` (its exceptions name it by `recurringEventId`). */
function googleSeries(
  props: Readonly<Record<string, unknown>>,
  id: 'eventId' | 'recurringEventId',
): string | null {
  const calendar = props['calendarId'];
  const event = props[id];
  return typeof calendar === 'string' && typeof event === 'string' ? `${calendar}|${event}` : null;
}

function locationOf(row: ItemQueryRow): string | null {
  const location = row.props['location'];
  if (typeof location !== 'string') return null;
  const trimmed = location.trim();
  return trimmed === '' ? null : trimmed;
}

export class TravelAnchors {
  readonly #caller: Caller;
  readonly #input: GatherInput;
  readonly #places: ReadonlyMap<string, Place>;
  readonly #pins: ReadonlyMap<string, string>;
  readonly #defaults: ReadonlyMap<string, string>;
  readonly #rules: readonly Scoped[];
  readonly #fates = new Map<string, AnchorFate>();
  /** Location texts geocoded (or tried) in this gather. */
  readonly #geocoded = new Map<string, LatLon | null>();
  #lookups = 0;

  private constructor(caller: Caller, input: GatherInput) {
    this.#caller = caller;
    this.#input = input;
    this.#places = new Map(input.places.map((place) => [place.id, place]));
    this.#pins = input.profile.itemPlaces;
    this.#defaults = input.profile.containerPlaces;
    // Oldest first: where-rules apply in that order (Ruling 11). Item and series rules beat them
    // whatever their age (#ruleFor).
    this.#rules = [...input.rules]
      .sort(
        (a, b) =>
          a.createdAt.getTime() - b.createdAt.getTime() || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
      )
      .map((rule) => ({ rule, scope: rule.scope }));
  }

  /** The member's anchors in `input.range` and the fate of every occurrence it holds. */
  static async gather(caller: Caller, input: GatherInput): Promise<Gathered> {
    return new TravelAnchors(caller, input).#gather();
  }

  async #gather(): Promise<Gathered> {
    const reads = await ItemQuery.for(this.#caller);
    const rows = await this.#rows(reads, ANCHOR_RULES, true);
    const matches = new Map<TravelRule, ReadonlySet<string>>();
    for (const { rule, scope } of this.#rules) {
      if (scope.kind === 'where') matches.set(rule, await this.#matching(reads, rule, scope.where));
    }
    this.#notHappening(rows);
    const { range } = this.#input;
    const anchors: Anchor[] = [];
    for (const occurrence of expandOccurrences(rows, range, this.#caller.settings.timezone)) {
      if (occurrence.allDay || occurrence.dueOnly) continue;
      const anchor = await this.#anchorOf(occurrence, matches);
      if (anchor !== null) anchors.push(anchor);
    }
    return { anchors, fates: this.#fates };
  }

  /** One occurrence as an anchor; null when no rule asks for travel to it. */
  async #anchorOf(
    occurrence: Occurrence,
    matches: ReadonlyMap<TravelRule, ReadonlySet<string>>,
  ): Promise<Anchor | null> {
    const row = occurrence.row as ItemQueryRow;
    const itemId = occurrence.seriesRowId ?? row.id;
    const slot =
      occurrence.originalStart === null ? 'single' : occurrence.originalStart.toISOString();
    const key = anchorKey(itemId, slot);
    const rule = this.#ruleFor(row.id, itemId, slot, matches);
    if (rule === null) {
      this.#fate(key, 'no_longer_matches');
      return null;
    }
    const placeId = await this.#placeOf(row, itemId, rule);
    this.#fate(key, placeId === null ? 'no_place' : 'present');
    return {
      itemId,
      occurrence: slot,
      title: row.title,
      topicId: row.topicId,
      start: occurrence.start,
      end: occurrence.end ?? occurrence.start,
      placeId,
      mode: rule.mode,
      there: rule.direction !== 'back',
      back: rule.direction !== 'there',
    };
  }

  /** The item rule of the occurrence, else its series', else the oldest where-rule matching it. */
  #ruleFor(
    rowId: string,
    itemId: string,
    slot: string,
    matches: ReadonlyMap<TravelRule, ReadonlySet<string>>,
  ): TravelRule | null {
    const item = this.#rules.find(
      ({ scope }) => scope.kind === 'item' && scope.itemId === itemId && scope.occurrence === slot,
    );
    if (item !== undefined) return item.rule;
    const series = this.#rules.find(
      ({ scope }) => scope.kind === 'series' && scope.itemId === itemId,
    );
    if (series !== undefined) return series.rule;
    for (const [rule, ids] of matches) {
      if (ids.has(rowId) || ids.has(itemId)) return rule;
    }
    return null;
  }

  /** Pin, rule's place, a name in its location, its location geocoded, its container's default. */
  async #placeOf(row: ItemQueryRow, itemId: string, rule: TravelRule): Promise<string | null> {
    const known = (id: string | null | undefined): string | null =>
      id !== null && id !== undefined && this.#places.has(id) ? id : null;
    const pinned = known(this.#pins.get(itemId)) ?? known(this.#pins.get(row.id));
    if (pinned !== null) return pinned;
    const ruled = known(rule.placeId);
    if (ruled !== null) return ruled;
    const location = locationOf(row);
    if (location !== null) {
      const places = [...this.#places.values()];
      const named = PlaceMatcher.byName(location, places);
      if (named !== null) return named.id;
      const point = await this.#geocode(location);
      const near = point === null ? null : nearestWithin(point, places, PLACE_MATCH_RADIUS_M);
      if (near !== null) return near.id;
    }
    return row.containerId === null ? null : known(this.#defaults.get(row.containerId));
  }

  /**
   * Where a location text is: typed "lat, lon"; else the member's cache; else, while lookups are
   * left, the geocoder's answer, kept for next time (a failed lookup is not kept: it is tried
   * again by the next gather).
   */
  async #geocode(text: string): Promise<LatLon | null> {
    const typed = parseCoordinates(text);
    if (typed !== null) return typed;
    const seen = this.#geocoded.get(text);
    if (seen !== undefined) return seen;
    const cached = this.#input.profile.cachedGeocode(text);
    if (cached !== undefined) return cached;
    if (this.#lookups >= NEW_GEOCODES_MAX) return null;
    this.#lookups += 1;
    let point: LatLon | null;
    try {
      point = await this.#input.geocoder.geocode(text);
    } catch (error) {
      // Never the text: it may be an address.
      logger.warn('travel: a location could not be geocoded', {
        workspaceId: this.#caller.workspaceId,
        reason: error instanceof Error ? error.name : 'unknown',
      });
      this.#geocoded.set(text, null);
      return null;
    }
    this.#geocoded.set(text, point);
    await this.#input.profile.storeGeocode(text, point);
    return point;
  }

  /**
   * The fates of occurrences that are not there to anchor: a skipped local occurrence and a
   * cancelled Google one were cancelled; a local one moved (perhaps out of the range) moved.
   * Whatever the expansion finds afterwards ranks above these.
   */
  #notHappening(rows: readonly ItemQueryRow[]): void {
    const masters = new Map<string, string>();
    for (const row of rows) {
      const own = googleSeries(row.props, 'eventId');
      if (own !== null && isSeriesRow(row)) masters.set(own, row.id);
    }
    for (const row of rows) {
      if (row.source.provider === 'local' && isSeriesRow(row)) {
        for (const exception of localExceptionsOf(row.props)) {
          const slot = new Date(exception.originalStart).toISOString();
          if (exception.skipped === true) this.#fate(anchorKey(row.id, slot), 'cancelled');
          else if (exception.startAt !== undefined) this.#fate(anchorKey(row.id, slot), 'moved');
        }
      }
      if (row.status !== 'cancelled') continue;
      const original = row.props['originalStartAt'];
      const slot = toDate(typeof original === 'string' ? original : null);
      const series = googleSeries(row.props, 'recurringEventId');
      const master = series === null ? undefined : masters.get(series);
      this.#fate(
        slot === null
          ? anchorKey(row.id, 'single')
          : anchorKey(master ?? row.id, slot.toISOString()),
        'cancelled',
      );
    }
  }

  #fate(key: string, fate: AnchorFate): void {
    const known = this.#fates.get(key);
    if (known === undefined || FATE_RANK[fate] > FATE_RANK[known]) this.#fates.set(key, fate);
  }

  /** The ids of the rows a where-rule matches in the range; none for a rule that no longer compiles. */
  async #matching(
    reads: ItemQuery,
    rule: TravelRule,
    where: RuleGroup,
  ): Promise<ReadonlySet<string>> {
    try {
      return new Set((await this.#rows(reads, where, false)).map((row) => row.id));
    } catch (error) {
      if (!(error instanceof QueryValidationError)) throw error;
      // A rule naming something gone (a removed attribute): it matches nothing now.
      logger.warn('travel: a where-rule no longer compiles', {
        workspaceId: this.#caller.workspaceId,
        ruleId: rule.id,
      });
      return new Set();
    }
  }

  /** The rows `where` matches in the range, as a calendar reads them. */
  async #rows(reads: ItemQuery, where: RuleGroup, anchors: boolean): Promise<ItemQueryRow[]> {
    const { range, now } = this.#input;
    const draft: Query = {
      source: 'items',
      where,
      dateRange: { from: range.from.toISOString(), to: range.to.toISOString() },
      dateField: 'startAt',
      sort: [{ field: 'startAt', dir: 'asc' }],
      limit: ANCHOR_ROWS_MAX,
    };
    const result = await reads.runDraft(draft, { now, blockType: 'calendar' });
    const rows = (result.rows ?? []).filter((row): row is ItemQueryRow => 'kind' in row);
    if (anchors && result.total > rows.length) {
      logger.warn('travel: more timed items than one regeneration reads', {
        workspaceId: this.#caller.workspaceId,
        read: rows.length,
        total: result.total,
      });
    }
    return rows;
  }
}
