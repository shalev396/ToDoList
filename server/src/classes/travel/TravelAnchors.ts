/**
 * A member's anchors for a range of days (docs/superpowers/specs/2026-11-17-travel-time-design.md,
 * "The day plan", 1; "Concepts", 2 and 3; plan Rulings 9 and 11): the timed occurrences they
 * travel to, each with its place and the rule that asks for travel; and what became of every
 * occurrence the range holds (its fate), so a leg that goes says why.
 *
 * - Rows: what the member may read, as a calendar reads it (ItemQuery#runDraft, `blockType:
 *   'calendar'`, so a series that began weeks ago is read too): a start, any kind but travel, in
 *   the range, at most ANCHOR_ROWS_MAX. Series are expanded on the workspace's wall clock; all-day
 *   and due-only occurrences never anchor, nor does an event Google shows as Free
 *   (`transparency: 'transparent'`), nor a cancelled or disabled occurrence (its fate:
 *   cancelled). A painted area anchors like a block (the owner's ruling of 2026-11-18), marked
 *   `area`: the day plan nests the items inside it (DayPlanner).
 * - Rule (Ruling 11): the item rule of that occurrence, else the series rule of its series, else
 *   the repeats rule an event that doesn't repeat falls under (the one
 *   chosen from the latest start), else the oldest where-rule that matches (each where-rule is its
 *   own draft, ANDed with the range).
 * - Place, in order: the member's pin of the item; the rule's place; a place named (or aliased) in
 *   the event's location, by whole words (`types/travelPlaceNames.ts`: nothing is looked up); the
 *   default place of its calendar or project. Otherwise none of its own: the day plan gives it the
 *   place of an area around it, if any, else it gets no travel (and the item says "set its place").
 * - An occurrence is anchored by its series (`seriesRowId`, a moved Google occurrence's master) or
 *   its own row, and by its ORIGINAL start (`single` for an item that doesn't repeat).
 *
 * Read-only: it reads items and writes nothing.
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
import type { TravelRuleScope } from '../../types/travel.js';
import { latestRepeats } from '../../types/travelRepeats.js';
import type { Caller } from '../base/Caller.js';
import { ItemQuery } from '../item/ItemQuery.js';
import type { Anchor } from './DayPlanner.js';
import type { AnchorFate } from './LegReconciler.js';
import type { Place } from './Place.js';
import { PlaceMatcher } from './PlaceMatcher.js';
import type { TravelProfile } from './TravelProfile.js';
import type { TravelRule } from './TravelRule.js';

/** The most rows one draft reads: a member's timed items over the horizon (a series is one). */
export const ANCHOR_ROWS_MAX = 1000;

export interface GatherInput {
  profile: TravelProfile;
  rules: readonly TravelRule[];
  places: readonly Place[];
  range: Range;
  now: Date;
}

export interface Gathered {
  anchors: Anchor[];
  /** By `anchorItemId|occurrence` (LegKey#anchorKey). */
  fates: Map<string, AnchorFate>;
  /** The rule that asks for each anchor's travel, by the same key (an anchor always has one). */
  rules: Map<string, TravelRule>;
}

/** One anchor occurrence as a gather finds it now, and the rule that makes it. */
export interface RuledAnchor {
  anchor: Anchor;
  rule: TravelRule;
}

/** How far around a moment `ruleOf` reads: an anchor that moved by a day or so is still found. */
const RULE_OF_MARGIN_MS = 36 * 60 * 60 * 1000;

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

/** Painted time (an area): travelled to like a block; the items inside it nest. */
const isArea = (row: ItemQueryRow): boolean =>
  row.kind === 'block' && row.props['layer'] === 'area';

/**
 * A Google Calendar event shown as Free (`props.transparency` `transparent`: Hanukkah, a
 * semester's end marker) anchors no travel. Any other value, or none, is busy.
 */
const isFree = (row: ItemQueryRow): boolean => row.props['transparency'] === 'transparent';

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
  readonly #ruled = new Map<string, TravelRule>();

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

  /**
   * The rule and the place of ONE anchor occurrence as a gather decides them now (the item rule,
   * else its series', else the oldest where-rule that matches: the one precedence, not a copy of
   * it). `near` is about when it starts (a leg's `anchorStart`); the day around it is read. Null
   * when the occurrence is no anchor any more (moved far, cancelled, no rule matches). The anchor
   * carries the mode, the way (`there`, `back`) and its resolved place.
   */
  static async ruleOf(
    caller: Caller,
    input: Omit<GatherInput, 'range'>,
    target: { itemId: string; occurrence: string; near: Date },
  ): Promise<RuledAnchor | null> {
    const range = {
      from: new Date(target.near.getTime() - RULE_OF_MARGIN_MS),
      to: new Date(target.near.getTime() + RULE_OF_MARGIN_MS),
    };
    const gathered = await TravelAnchors.gather(caller, { ...input, range });
    const anchor = gathered.anchors.find(
      (one) => one.itemId === target.itemId && one.occurrence === target.occurrence,
    );
    const rule = gathered.rules.get(anchorKey(target.itemId, target.occurrence));
    return anchor === undefined || rule === undefined ? null : { anchor, rule };
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
      if (occurrence.inactive !== null) {
        // Cancelled or disabled: its time is free, so nobody travels to it; a leg made for it
        // goes, as cancelled (the owner's ruling of 2026-11-22).
        this.#fate(this.#keyOf(occurrence), 'cancelled');
        continue;
      }
      const anchor = this.#anchorOf(occurrence, matches);
      if (anchor !== null) anchors.push(anchor);
    }
    return { anchors, fates: this.#fates, rules: this.#ruled };
  }

  /** One occurrence as an anchor; null when no rule asks for travel to it. */
  #anchorOf(
    occurrence: Occurrence,
    matches: ReadonlyMap<TravelRule, ReadonlySet<string>>,
  ): Anchor | null {
    const row = occurrence.row as ItemQueryRow;
    const itemId = occurrence.seriesRowId ?? row.id;
    const slot =
      occurrence.originalStart === null ? 'single' : occurrence.originalStart.toISOString();
    const key = this.#keyOf(occurrence);
    if (isFree(row)) {
      // "Show as: Free": a marker (a holiday, a semester's end), never somewhere he goes. A leg
      // made for it before it was marked free goes, as no longer matching.
      this.#fate(key, 'no_longer_matches');
      return null;
    }
    const rule = this.#ruleFor(row, itemId, slot, matches);
    if (rule === null) {
      this.#fate(key, 'no_longer_matches');
      return null;
    }
    const placeId = this.#placeOf(row, itemId, rule);
    this.#fate(key, placeId === null ? 'no_place' : 'present');
    this.#ruled.set(key, rule);
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
      area: isArea(row),
      ...(rule.arriveEarlyMinutes > 0 ? { early: rule.arriveEarlyMinutes } : {}),
      ...(rule.lengths === null ? {} : { lengths: rule.lengths }),
    };
  }

  /** The item rule of the occurrence, else its series', else the oldest where-rule matching it. */
  #ruleFor(
    row: ItemQueryRow,
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
    const repeats = this.#repeatsRuleFor(row, itemId, slot);
    if (repeats !== null) return repeats;
    for (const [rule, ids] of matches) {
      if (ids.has(row.id) || ids.has(itemId)) return rule;
    }
    return null;
  }

  /**
   * The repeats rule (the one from the latest start) an event that doesn't repeat (a single, never a series occurrence)
   * is a repeat of: same calendar or project and title, same weekday and local start time, at or
   * after the rule's `from` (so an event imported after the rule is covered too).
   */
  #repeatsRuleFor(row: ItemQueryRow, itemId: string, slot: string): TravelRule | null {
    if (slot !== 'single' || itemId !== row.id || row.startAt === null || isSeriesRow(row)) {
      return null;
    }
    const zone = this.#caller.settings.timezone;
    // The event's own title, not one he renamed it to in TodoList.
    const event = {
      containerId: row.containerId,
      title: row.sourceTitle ?? row.title,
      startAt: row.startAt,
    };
    const repeats = this.#rules.flatMap(({ rule, scope }) =>
      scope.kind === 'repeats' ? [{ rule, scope }] : [],
    );
    return latestRepeats(repeats, event, zone)?.rule ?? null;
  }

  /** Pin, rule's place, a place its location names, its container's default; else none. */
  #placeOf(row: ItemQueryRow, itemId: string, rule: TravelRule): string | null {
    return TravelAnchors.placeOf(
      { id: row.id, location: locationOf(row), containerId: row.containerId },
      itemId,
      rule.placeId,
      { places: [...this.#places.values()], pins: this.#pins, defaults: this.#defaults },
    );
  }

  /**
   * Where an item is by its own, as a gather places it: the member's pin of it (by `itemId`, its
   * series' for an occurrence, or its own row), the rule's place, a place its location names by
   * name or alias, its calendar's or project's default; null when none (an area may lend it one,
   * which only the day plan knows). The ids it answers are the member's own places only. Pure.
   */
  static placeOf(
    row: { id: string; location: string | null; containerId: string | null },
    itemId: string,
    rulePlaceId: string | null,
    own: {
      places: readonly Place[];
      pins: ReadonlyMap<string, string>;
      defaults: ReadonlyMap<string, string>;
    },
  ): string | null {
    const ids = new Set(own.places.map((place) => place.id));
    const known = (id: string | null | undefined): string | null =>
      id !== null && id !== undefined && ids.has(id) ? id : null;
    const pinned = known(own.pins.get(itemId)) ?? known(own.pins.get(row.id));
    if (pinned !== null) return pinned;
    const ruled = known(rulePlaceId);
    if (ruled !== null) return ruled;
    const named = row.location === null ? null : PlaceMatcher.byName(row.location, own.places);
    if (named !== null) return named.id;
    return row.containerId === null ? null : known(own.defaults.get(row.containerId));
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

  /** An occurrence's anchor key: its series (or own row) and its original start, or `single`. */
  #keyOf(occurrence: Occurrence): string {
    return anchorKey(
      occurrence.seriesRowId ?? occurrence.row.id,
      occurrence.originalStart === null ? 'single' : occurrence.originalStart.toISOString(),
    );
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
    const result = await reads.runDraft(draft, {
      now,
      blockType: 'calendar',
      sourceTitle: anchors,
    });
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
