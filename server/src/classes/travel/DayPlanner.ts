/**
 * The day plan (docs/superpowers/specs/2026-11-17-travel-time-design.md, "The day plan"): one
 * member's anchors for one day, their Home and their settings in; the day's travel legs out. Pure,
 * with no I/O. Every length comes from the estimates the caller worked out beforehand for exactly
 * the trips `trips()` lists.
 *
 * - Anchors are the day's timed items with travel and a place. A day is the workspace time zone's
 *   calendar day, 23 or 25 hours long on a daylight-saving change. An anchor belongs to the day it
 *   starts in, so a leg home after midnight still belongs to the day before.
 * - Consecutive anchors at one place are one stay: the windows between them are spent there. With
 *   "go home in a window" on, a long enough window becomes a trip home and back.
 * - Legs: Home to the first stay (when its first anchor asks for `there`), one between each two
 *   stays (always, in the destination's mode), and the last stay back Home (when its last anchor
 *   asks for `back`).
 * - A leg there arrives as its anchor starts; a leg back leaves as its stay ends. A leg between two
 *   stays that can't fit leaves as the first ends and is marked a conflict: the plan never moves
 *   an event.
 *
 * Titles are English templates (plan Ruling 19) with place names only, never an address.
 */
import { zonedTime } from '../../types/recurrence/zoned.js';
import type { TravelDirection, TravelMode, TravelSettings } from '../../types/travel.js';
import { LegKey } from './LegKey.js';

/** A timed item occurrence the member travels to, as the plan reads it. */
export interface Anchor {
  /** The item, or its series master for an occurrence of a series. */
  itemId: string;
  /** The occurrence's ORIGINAL start (ISO), or `single` for an item that doesn't repeat. */
  occurrence: string;
  title: string;
  topicId: string | null;
  /** Where the occurrence is now (moved or not). */
  start: Date;
  end: Date;
  /** Null: it has no place, so it gets no travel. */
  placeId: string | null;
  mode: TravelMode;
  /** Travel there when it opens the day. */
  there: boolean;
  /** Travel back Home when it closes the day. */
  back: boolean;
}

export interface DayPlanInput {
  ownerUserId: string;
  /** The calendar day, `YYYY-MM-DD`, in `timeZone`. */
  day: string;
  timeZone: string;
  now: Date;
  /** The member's Home: without one there is no travel. */
  homeId: string | null;
  /** The member's place names by id, for the legs' titles. */
  placeNames: ReadonlyMap<string, string>;
  settings: TravelSettings;
  anchors: readonly Anchor[];
}

/** One trip a leg can take: `from|to|mode`, by place id. */
export type TripKey = string;

export interface Estimate {
  minutes: number;
  source: 'ors' | 'remembered' | 'estimate';
}

export interface PlannedLeg {
  key: LegKey;
  /** When its anchor starts (as moved): an edited leg is flagged when this changes. */
  anchorStart: Date;
  fromPlaceId: string;
  toPlaceId: string;
  mode: TravelMode;
  startAt: Date;
  endAt: Date;
  minutes: number;
  source: Estimate['source'];
  /** It can't be made in time: it leaves as the stay before it ends, after the next one starts. */
  conflict: boolean;
  /**
   * It starts before now: never created or restored. A stored leg for it that hasn't started yet
   * goes, as `moved` (its anchor moved earlier).
   */
  past: boolean;
  topicId: string | null;
  title: string;
}

const MS_PER_MINUTE = 60_000;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** The title's verb per mode: "Bus to Braude", "Drive home". */
const VERBS: Readonly<Record<TravelMode, string>> = {
  transit: 'Bus',
  drive: 'Drive',
  walk: 'Walk',
};

type Located = Anchor & { placeId: string };

/** Time spent at one place: its anchors in order (never none), until the last of them ends. */
interface Stay {
  readonly kind: 'stay';
  readonly placeId: string;
  readonly anchors: readonly Located[];
  readonly first: Located;
  readonly last: Located;
  readonly start: Date;
  readonly end: Date;
}

/** A trip home in a window at a place (go home in a window): no anchors of its own. */
interface HomeWindow {
  readonly kind: 'home';
}

type Stop = Stay | HomeWindow;

/** A leg before its length is known: a there leg arrives by, a back leg departs at, a between both. */
type LegSpec = { anchor: Located; from: string; to: string; mode: TravelMode } & (
  | { direction: Extract<TravelDirection, 'there'>; arriveBy: Date }
  | { direction: Extract<TravelDirection, 'back'>; departAt: Date }
  | { direction: Extract<TravelDirection, 'between'>; departAt: Date; arriveBy: Date }
);

/** A window between two anchors of a stay, long enough to go home in. */
interface Window {
  /** The anchor after the window: the stay splits before it. */
  index: number;
  minutes: number;
  /** Home in the mode of the anchor before the window, back in the mode of the one after. */
  home: TripKey;
  back: TripKey;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byStart = (a: Anchor, b: Anchor): number =>
  a.start.getTime() - b.start.getTime() ||
  a.end.getTime() - b.end.getTime() ||
  compareText(a.itemId, b.itemId) ||
  compareText(a.occurrence, b.occurrence);

const byTimeThenKey = (a: PlannedLeg, b: PlannedLeg): number =>
  a.startAt.getTime() - b.startAt.getTime() || compareText(a.key.toString(), b.key.toString());

function stayOf(anchors: readonly Located[]): Stay {
  const [first] = anchors;
  const last = anchors.at(-1);
  if (first === undefined || last === undefined) throw new Error('DayPlanner: an empty stay');
  const end = Math.max(...anchors.map((anchor) => anchor.end.getTime()));
  return {
    kind: 'stay',
    placeId: first.placeId,
    anchors,
    first,
    last,
    start: first.start,
    end: new Date(end),
  };
}

/** The first instant of `day` in `timeZone` and of the day after it. */
function dayBounds(day: string, timeZone: string): { start: Date; end: Date } {
  const refuse = (): Error => new Error('DayPlanner: day must be a real date, YYYY-MM-DD');
  const match = DAY_PATTERN.exec(day);
  if (match === null) throw refuse();
  const [year, month, date] = match.slice(1, 4).map(Number) as [number, number, number];
  // Date.UTC rolls 30 February over into March: that is no day.
  const asUtc = new Date(Date.UTC(year, month - 1, date));
  if (asUtc.getUTCMonth() !== month - 1 || asUtc.getUTCDate() !== date) throw refuse();
  const next = new Date(Date.UTC(year, month - 1, date + 1));
  return {
    start: zonedTime(year, month, date, 0, 0, timeZone),
    end: zonedTime(
      next.getUTCFullYear(),
      next.getUTCMonth() + 1,
      next.getUTCDate(),
      0,
      0,
      timeZone,
    ),
  };
}

export class DayPlanner {
  readonly #input: DayPlanInput;
  readonly #homeId: string;
  /** The day's stays, before any window is spent at home. */
  readonly #stays: readonly Stay[];

  private constructor(input: DayPlanInput, homeId: string) {
    this.#input = input;
    this.#homeId = homeId;
    const { start, end } = dayBounds(input.day, input.timeZone);
    const anchors = input.anchors
      .filter((anchor): anchor is Located => anchor.placeId !== null)
      .filter((anchor) => anchor.start >= start && anchor.start < end)
      .sort(byStart);
    const groups: Located[][] = [];
    for (const anchor of anchors) {
      const open = groups.at(-1);
      if (open?.[0]?.placeId === anchor.placeId) open.push(anchor);
      else groups.push([anchor]);
    }
    this.#stays = groups.map(stayOf);
  }

  static tripKey(from: string, to: string, mode: TravelMode): TripKey {
    return [from, to, mode].join('|');
  }

  /**
   * Every trip `plan()` may read a length for: the legs' trips, and with going home on, both trips
   * of each window long enough to go home in (the plan reads them to decide).
   */
  static trips(input: DayPlanInput): TripKey[] {
    const planner = DayPlanner.#of(input);
    if (planner === null) return [];
    const trips = new Set<TripKey>();
    for (const spec of planner.#legsAlong(planner.#stays)) {
      trips.add(DayPlanner.tripKey(spec.from, spec.to, spec.mode));
    }
    for (const stay of planner.#stays) {
      for (const window of planner.#windowsIn(stay)) {
        trips.add(window.home);
        trips.add(window.back);
      }
    }
    return [...trips];
  }

  /**
   * The day's legs, by start time (ties by key). `estimates` must hold every trip `trips()` lists
   * for the same input: a trip it lacks is the caller's mistake, and throws.
   */
  static plan(input: DayPlanInput, estimates: ReadonlyMap<TripKey, Estimate>): PlannedLeg[] {
    const planner = DayPlanner.#of(input);
    if (planner === null) return [];
    const length = (trip: TripKey): Estimate => {
      const estimate = estimates.get(trip);
      if (estimate === undefined) throw new Error(`DayPlanner: no estimate for the trip ${trip}`);
      return estimate;
    };
    const stops = planner.#stays.flatMap((stay) => planner.#homeInWindows(stay, length));
    return planner
      .#legsAlong(stops)
      .map((spec) => planner.#timed(spec, length))
      .sort(byTimeThenKey);
  }

  static #of(input: DayPlanInput): DayPlanner | null {
    return input.homeId === null ? null : new DayPlanner(input, input.homeId);
  }

  /** The windows of a stay long enough to go home in: none unless going home is on, nor at Home. */
  #windowsIn(stay: Stay): Window[] {
    const { enabled, minWindowMinutes } = this.#input.settings.goHome;
    if (!enabled || stay.placeId === this.#homeId) return [];
    const windows: Window[] = [];
    // A window starts when every anchor before it has ended.
    let freeFrom = stay.first.end.getTime();
    stay.anchors.forEach((after, index) => {
      const before = stay.anchors[index - 1];
      if (before === undefined) return;
      freeFrom = Math.max(freeFrom, before.end.getTime());
      const minutes = (after.start.getTime() - freeFrom) / MS_PER_MINUTE;
      if (minutes < minWindowMinutes) return;
      windows.push({
        index,
        minutes,
        home: DayPlanner.tripKey(stay.placeId, this.#homeId, before.mode),
        back: DayPlanner.tripKey(this.#homeId, stay.placeId, after.mode),
      });
    });
    return windows;
  }

  /** A stay, split by a trip home in each window that leaves enough time at home. */
  #homeInWindows(stay: Stay, length: (trip: TripKey) => Estimate): Stop[] {
    const { minAtHomeMinutes } = this.#input.settings.goHome;
    const cuts = this.#windowsIn(stay)
      .filter(
        (w) => w.minutes - length(w.home).minutes - length(w.back).minutes >= minAtHomeMinutes,
      )
      .map((w) => w.index);
    if (cuts.length === 0) return [stay];
    const stops: Stop[] = [];
    let from = 0;
    for (const cut of cuts) {
      stops.push(stayOf(stay.anchors.slice(from, cut)), { kind: 'home' });
      from = cut;
    }
    stops.push(stayOf(stay.anchors.slice(from)));
    return stops;
  }

  /** The legs along the day's stops, before their lengths are known. */
  #legsAlong(stops: readonly Stop[]): LegSpec[] {
    const home = this.#homeId;
    const specs: LegSpec[] = [];
    const first = stops[0];
    if (first?.kind === 'stay' && first.placeId !== home && first.first.there) {
      specs.push(this.#there(first.first, home, first.placeId, first.start));
    }
    stops.forEach((next, index) => {
      const previous = stops[index - 1];
      if (previous === undefined) return;
      if (previous.kind === 'stay' && next.kind === 'home') {
        specs.push(this.#back(previous.last, previous.placeId, home, previous.end));
      } else if (previous.kind === 'home' && next.kind === 'stay') {
        specs.push(this.#there(next.first, home, next.placeId, next.start));
      } else if (
        previous.kind === 'stay' &&
        next.kind === 'stay' &&
        previous.placeId !== next.placeId
      ) {
        // The destination decides the mode: by bus to Braude, then by car on to TLVTech.
        specs.push({
          direction: 'between',
          anchor: next.first,
          from: previous.placeId,
          to: next.placeId,
          mode: next.first.mode,
          departAt: previous.end,
          arriveBy: next.start,
        });
      }
    });
    const last = stops.at(-1);
    if (last?.kind === 'stay' && last.placeId !== home && last.last.back) {
      specs.push(this.#back(last.last, last.placeId, home, last.end));
    }
    return specs;
  }

  #there(anchor: Located, from: string, to: string, arriveBy: Date): LegSpec {
    return { direction: 'there', anchor, from, to, mode: anchor.mode, arriveBy };
  }

  #back(anchor: Located, from: string, to: string, departAt: Date): LegSpec {
    return { direction: 'back', anchor, from, to, mode: anchor.mode, departAt };
  }

  /**
   * A leg with its length. There: it arrives as its anchor starts. Back: it leaves as its stay
   * ends. Between: it arrives by the next stay's start when it can, else it leaves as the stay
   * before ends and is a conflict.
   */
  #timed(spec: LegSpec, length: (trip: TripKey) => Estimate): PlannedLeg {
    const { anchor, from, to, mode } = spec;
    const estimate = length(DayPlanner.tripKey(from, to, mode));
    const span = estimate.minutes * MS_PER_MINUTE;
    let start: number;
    let conflict = false;
    switch (spec.direction) {
      case 'there':
        start = spec.arriveBy.getTime() - span;
        break;
      case 'back':
        start = spec.departAt.getTime();
        break;
      case 'between':
        start = Math.max(spec.arriveBy.getTime() - span, spec.departAt.getTime());
        conflict = start + span > spec.arriveBy.getTime();
        break;
    }
    const startAt = new Date(start);
    return {
      key: LegKey.of({
        ownerUserId: this.#input.ownerUserId,
        anchorItemId: anchor.itemId,
        occurrence: anchor.occurrence,
        direction: spec.direction,
      }),
      anchorStart: new Date(anchor.start.getTime()),
      fromPlaceId: from,
      toPlaceId: to,
      mode,
      startAt,
      endAt: new Date(start + span),
      minutes: estimate.minutes,
      source: estimate.source,
      conflict,
      past: startAt < this.#input.now,
      topicId: anchor.topicId,
      title: this.#title(mode, to, anchor),
    };
  }

  /** "Bus to Braude", "Drive home": the place's name, or its anchor's title if it has none. */
  #title(mode: TravelMode, to: string, anchor: Anchor): string {
    if (to === this.#homeId) return `${VERBS[mode]} home`;
    return `${VERBS[mode]} to ${this.#input.placeNames.get(to) ?? anchor.title}`;
  }
}
