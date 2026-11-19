/**
 * The day plan (docs/superpowers/specs/2026-11-17-travel-time-design.md, "The day plan"): one
 * member's anchors for one day, their Home and their settings in; the day's travel legs out. Pure,
 * with no I/O. Every length comes from the lengths the caller read beforehand for exactly the trips
 * `trips()` lists (the member's own, or the placeholder of a trip he hasn't set: it plans alike).
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
 * - A painted area (`area`, "Studying 8–16 at Braude") anchors like any item, and the items inside
 *   it nest (the owner's ruling of 2026-11-18):
 *   - an inner item with a place of its own is there for its own time: the area is cut around it
 *     (an inner area cuts the one around it; of two areas that overlap, the one starting later is
 *     the inner one);
 *   - an inner item with no place takes the place of the area around its start (the innermost);
 *   - the rest of the area is spent at the area's place, so two inner items there are one stay;
 *   - the leg back into the area after an inner item elsewhere leaves as that item ends, in the
 *     mode it was reached by, keyed as that item's `back`: the area resumes whenever he gets there
 *     (a conflict only when it reaches an appointment there late). Leaving the area for an inner
 *     item arrives as that item starts, and may leave before the area's painted time ends;
 *   - he goes back into a part of an area that holds no appointment only when the gap holds the
 *     trip back and the trip on, and he gets there before the part ends (ruling of 2026-11-18);
 *     otherwise he goes straight on, or home, from the item before it;
 *   - when the day's last area part is skipped that way, the way home is still the area's: it
 *     exists only when the area asks for `back`, goes in the area's mode and is keyed as the
 *     area's `back` (as any leg home is keyed to whose way home it is), only starting from where
 *     he is (ruling of 2026-11-19);
 *   - a leg home leaves at the later of its stay's end and the time he can leave it.
 *
 * Titles are English templates (plan Ruling 19) with place names only, never an address.
 */
import { zonedTime } from '../../types/recurrence/zoned.js';
import type { LegSource, TravelDirection, TravelMode, TravelSettings } from '../../types/travel.js';
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
  /** Null: it has no place of its own (it takes an area's around it, else it gets no travel). */
  placeId: string | null;
  mode: TravelMode;
  /** Travel there when it opens the day. */
  there: boolean;
  /** Travel back Home when it closes the day. */
  back: boolean;
  /** A painted area: the items inside it nest (see the top of this file). */
  area: boolean;
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

/** A trip's length: the one its member set, or UNSET_TRIP_MINUTES while he hasn't (`unset`). */
export interface Estimate {
  minutes: number;
  source: LegSource;
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
   * goes as `moved` only when its anchor moved; one the member edited, or whose trip just got
   * longer, stays (LegReconciler).
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

/**
 * A stretch of the day at one anchor's place: the whole anchor, or a part of an area that the
 * items inside it, elsewhere, leave. A part starts softly where such an item ends (he gets back
 * when he can) and ends softly where one starts (he leaves when he must).
 */
interface Piece {
  /** Its anchor: the item itself, or the whole area it is a part of. */
  readonly anchor: Located;
  readonly start: Date;
  readonly end: Date;
  readonly softStart: boolean;
  readonly softEnd: boolean;
}

/** Time spent at one place: its pieces in order (never none), until the last of them ends. */
interface Stay {
  readonly kind: 'stay';
  readonly placeId: string;
  readonly pieces: readonly Piece[];
  readonly first: Piece;
  /** The piece whose anchor closes it: the last in order, or an area ending as the stay ends. */
  readonly last: Piece;
  readonly start: Date;
  readonly end: Date;
  /** The earliest start that is an appointment (not an area resuming); null: none. */
  readonly hardStart: Date | null;
  /** When its last appointment ends (not an area cut short); null: none. */
  readonly hardEnd: Date | null;
  /**
   * Whose way home a leg home from it is (its flag, mode and key): what closes it, or, when the
   * area parts after it to the end of the day are skipped (#visited), the area that closes the
   * last of them.
   */
  readonly wayHome: Located;
}

/** A trip home in a window at a place (go home in a window): no anchors of its own. */
interface HomeWindow {
  readonly kind: 'home';
}

type Stop = Stay | HomeWindow;

/**
 * When a leg can leave: the latest of its terms, each a time plus the lengths of some trips (`at`,
 * then `after`: the trips that bring him back into the area he leaves). A leg home also waits for
 * its stay to end.
 */
interface Departure {
  leaves: readonly { at: Date; after: readonly TripKey[] }[];
}

/**
 * A leg before its length is known: a there leg arrives by; a back leg departs (Home, or back into
 * the area around the item it leaves, by `arriveBy` when an appointment waits there); a between
 * leg both.
 */
type LegSpec = { anchor: Located; from: string; to: string; mode: TravelMode } & (
  | { direction: Extract<TravelDirection, 'there'>; arriveBy: Date }
  | ({ direction: Extract<TravelDirection, 'back'>; arriveBy: Date | null } & Departure)
  | ({ direction: Extract<TravelDirection, 'between'>; arriveBy: Date } & Departure)
);

/** A window between two pieces of a stay, long enough to go home in. */
interface Window {
  /** The piece after the window: the stay splits before it. */
  index: number;
  minutes: number;
  /** Home in the mode of what closes the stay before the window, back in that of the one after. */
  home: TripKey;
  back: TripKey;
}

const compareText = (a: string, b: string): number => (a < b ? -1 : a > b ? 1 : 0);

const byKey = (a: Anchor, b: Anchor): number =>
  compareText(a.itemId, b.itemId) || compareText(a.occurrence, b.occurrence);

/**
 * By start; at one start an appointment before an area resuming, an area before what it holds
 * (the longer area first), then by end and key (as anchors always sorted).
 */
const byStart = (a: Piece, b: Piece): number =>
  a.start.getTime() - b.start.getTime() ||
  Number(a.softStart) - Number(b.softStart) ||
  Number(b.anchor.area) - Number(a.anchor.area) ||
  (a.anchor.area && b.anchor.area
    ? b.end.getTime() - a.end.getTime()
    : a.end.getTime() - b.end.getTime()) ||
  byKey(a.anchor, b.anchor);

const byTimeThenKey = (a: PlannedLeg, b: PlannedLeg): number =>
  a.startAt.getTime() - b.startAt.getTime() || compareText(a.key.toString(), b.key.toString());

/** An anchor, or a part of an area, while it lasts; one with no length is there at its start. */
const holds = (piece: { start: Date; end: Date }, at: Date): boolean =>
  piece.start <= at && at < piece.end;

/** Whether `a` overlaps `b`; an anchor with no length overlaps when `b` holds its start. */
function overlaps(a: { start: Date; end: Date }, b: { start: Date; end: Date }): boolean {
  if (a.end <= a.start) return holds(b, a.start);
  return a.start < b.end && a.end > b.start;
}

/** Whether area `inner` sits inside area `outer`: it starts later, or as long ends sooner. */
const isInner = (inner: Anchor, outer: Anchor): boolean =>
  inner.start.getTime() - outer.start.getTime() > 0 ||
  (inner.start.getTime() === outer.start.getTime() &&
    (outer.end.getTime() - inner.end.getTime() || byKey(outer, inner)) > 0);

/** The innermost of some areas: the one starting latest, then ending soonest. */
const innermost = (areas: readonly Located[]): Located | undefined =>
  areas.reduce<Located | undefined>(
    (inner, area) => (inner === undefined || isInner(area, inner) ? area : inner),
    undefined,
  );

/** The whole of an anchor. */
const whole = (anchor: Located): Piece => ({
  anchor,
  start: anchor.start,
  end: anchor.end,
  softStart: false,
  softEnd: false,
});

/**
 * The parts of an area the items inside it leave: it minus the times of the anchors that cut it
 * (elsewhere, overlapping it, and not an area it sits inside).
 */
function partsOf(area: Located, anchors: readonly Located[]): Piece[] {
  const cuts = anchors
    .filter(
      (other) =>
        other !== area &&
        other.placeId !== area.placeId &&
        overlaps(other, area) &&
        (!other.area || isInner(other, area)),
    )
    .map((other) => ({
      start: Math.max(other.start.getTime(), area.start.getTime()),
      end: Math.min(Math.max(other.end.getTime(), other.start.getTime()), area.end.getTime()),
    }))
    .sort((a, b) => a.start - b.start);
  if (cuts.length === 0) return [whole(area)];
  const parts: Piece[] = [];
  const part = (start: number, end: number, softStart: boolean, softEnd: boolean): void => {
    parts.push({ anchor: area, start: new Date(start), end: new Date(end), softStart, softEnd });
  };
  let from = area.start.getTime();
  let cut = false;
  for (const { start, end } of cuts) {
    if (start > from) part(from, start, cut, true);
    from = Math.max(from, end);
    cut = true;
  }
  if (from < area.end.getTime()) part(from, area.end.getTime(), true, false);
  return parts;
}

/** The anchors with a place: their own, or that of the innermost area around their start. */
function placed(anchors: readonly Anchor[]): Located[] {
  const own = anchors.filter((anchor): anchor is Located => anchor.placeId !== null);
  const areas = own.filter((anchor) => anchor.area);
  return anchors.flatMap((anchor): Located[] => {
    if (anchor.placeId !== null) return [anchor as Located];
    const around = innermost(areas.filter((area) => holds(area, anchor.start)));
    return around === undefined ? [] : [{ ...anchor, placeId: around.placeId }];
  });
}

/**
 * What closes some pieces that end at `end`: the last area among them that ends then and isn't
 * cut short (an area's legs go at its own end), else the last of them.
 */
function closing(pieces: readonly Piece[], end: number): Piece | undefined {
  const area = [...pieces]
    .reverse()
    .find((piece) => piece.anchor.area && !piece.softEnd && piece.end.getTime() === end);
  return area ?? pieces.at(-1);
}

/** A stay that is only an area resumed after an item elsewhere: no appointment of its own. */
const isResumedOnly = (stay: Stay): boolean => stay.first.softStart && stay.hardStart === null;

function stayOf(pieces: readonly Piece[]): Stay {
  const [first] = pieces;
  if (first === undefined) throw new Error('DayPlanner: an empty stay');
  const end = Math.max(...pieces.map((piece) => piece.end.getTime()));
  const last = closing(pieces, end);
  if (last === undefined) throw new Error('DayPlanner: an empty stay');
  const hardStarts = pieces.filter((piece) => !piece.softStart).map((p) => p.start.getTime());
  const hardEnds = pieces.filter((piece) => !piece.softEnd).map((p) => p.end.getTime());
  return {
    kind: 'stay',
    placeId: first.anchor.placeId,
    pieces,
    first,
    last,
    start: first.start,
    end: new Date(end),
    hardStart: hardStarts.length === 0 ? null : new Date(Math.min(...hardStarts)),
    hardEnd: hardEnds.length === 0 ? null : new Date(Math.max(...hardEnds)),
    wayHome: last.anchor,
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
    const anchors = placed(
      input.anchors.filter((anchor) => anchor.start >= start && anchor.start < end),
    );
    const pieces = anchors
      .flatMap((anchor) => (anchor.area ? partsOf(anchor, anchors) : [whole(anchor)]))
      .sort(byStart);
    const groups: Piece[][] = [];
    for (const piece of pieces) {
      const open = groups.at(-1);
      if (open?.[0]?.anchor.placeId === piece.anchor.placeId) open.push(piece);
      else groups.push([piece]);
    }
    this.#stays = groups.map(stayOf);
  }

  static tripKey(from: string, to: string, mode: TravelMode): TripKey {
    return [from, to, mode].join('|');
  }

  /**
   * Every trip `plan()` may read a length for: the legs' trips, the trips that skip an area part he
   * may not go back into (straight on, or home), and with going home on, both trips of each window
   * long enough to go home in (the plan reads them to decide).
   */
  static trips(input: DayPlanInput): TripKey[] {
    const planner = DayPlanner.#of(input);
    if (planner === null) return [];
    const trips = new Set<TripKey>();
    for (const spec of planner.#legsAlong(planner.#stays)) {
      trips.add(DayPlanner.tripKey(spec.from, spec.to, spec.mode));
    }
    for (const trip of planner.#shortcuts()) trips.add(trip);
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
    const stops = planner.#visited(length).flatMap((stay) => planner.#homeInWindows(stay, length));
    return planner
      .#legsAlong(stops)
      .map((spec) => planner.#timed(spec, length))
      .sort(byTimeThenKey);
  }

  static #of(input: DayPlanInput): DayPlanner | null {
    return input.homeId === null ? null : new DayPlanner(input, input.homeId);
  }

  /**
   * The day's items that sit inside a marked area at its place (their own, or the one they take
   * from it), each with the innermost such area: they are spent in the area's stay, so they make
   * no trips of their own. Without a Home, too: it names where an item is, not its legs.
   */
  static hosts(input: DayPlanInput): { anchor: Anchor; area: Anchor }[] {
    const { start, end } = dayBounds(input.day, input.timeZone);
    const anchors = placed(
      input.anchors.filter((anchor) => anchor.start >= start && anchor.start < end),
    );
    const areas = anchors.filter((anchor) => anchor.area);
    return anchors.flatMap((anchor) => {
      if (anchor.area) return [];
      const area = innermost(
        areas.filter((one) => one.placeId === anchor.placeId && holds(one, anchor.start)),
      );
      return area === undefined ? [] : [{ anchor, area }];
    });
  }

  /**
   * The stays he goes to: all of them, but an area part with no appointment of its own that he'd
   * go back into from an item elsewhere only when the gap holds the trip back and the trip on (to
   * the stay after it, arriving by its start), and he gets there before the part ends. Otherwise
   * he goes straight on (or home) from the stay before it: two items at one place either side of
   * it are then one visit, with no trip between them. When the day's last parts are skipped, the
   * last stay he goes to owes the area's way home (`wayHome`).
   */
  #visited(length: (trip: TripKey) => Estimate): Stay[] {
    const minutes = (trip: TripKey): number => length(trip).minutes * MS_PER_MINUTE;
    const visited: Stay[] = [];
    // When he gets back into an area part he left an item for: he leaves it no sooner.
    const arrivals = new Map<Stay, number>();
    // The last stay skipped since the last one he goes to.
    let skipped: Stay | null = null;
    for (const [index, stay] of this.#stays.entries()) {
      const previous = visited.at(-1);
      if (previous === undefined || previous.placeId === stay.placeId || !stay.first.softStart) {
        visited.push(stay);
        skipped = null;
        continue;
      }
      // As #leaving: once its appointments are over and he is there.
      const known = [previous.hardEnd?.getTime(), arrivals.get(previous)].filter(
        (time): time is number => time !== undefined,
      );
      const leaves = known.length === 0 ? previous.start.getTime() : Math.max(...known);
      const arrives = leaves + minutes(this.#legTrip(previous, stay));
      const next = this.#stays[index + 1];
      const deadline =
        next === undefined ? null : next.first.softStart ? next.hardStart : next.start;
      const fits =
        arrives < stay.end.getTime() &&
        (next === undefined ||
          deadline === null ||
          arrives + minutes(this.#legTrip(stay, next)) <= deadline.getTime());
      if (fits || !isResumedOnly(stay)) {
        visited.push(stay);
        arrivals.set(stay, arrives);
        skipped = null;
      } else {
        skipped = stay;
      }
    }
    const last = visited.at(-1);
    // Skipping his way back into the area doesn't change whose way home it is.
    if (last !== undefined && skipped !== null) {
      visited[visited.length - 1] = { ...last, wayHome: skipped.wayHome };
    }
    return visited;
  }

  /**
   * The trips of the legs the plan takes instead when it skips area parts (#visited): from each
   * stay straight to a later one when every stay between may be skipped, or home when every stay
   * after it may.
   */
  #shortcuts(): TripKey[] {
    const stays = this.#stays;
    const trips: TripKey[] = [];
    stays.forEach((from, index) => {
      for (let to = index + 1; to <= stays.length; to += 1) {
        const target = stays[to];
        if (to > index + 1) {
          const owed = stays.at(-1);
          if (target === undefined) {
            // The way home of the area whose last part is skipped, from where he is.
            if (from.placeId !== this.#homeId && owed !== undefined) {
              trips.push(DayPlanner.tripKey(from.placeId, this.#homeId, owed.wayHome.mode));
            }
          } else if (target.placeId !== from.placeId) {
            trips.push(this.#legTrip(from, target));
          }
        }
        if (target === undefined || !isResumedOnly(target)) break;
      }
    });
    return trips;
  }

  /**
   * The mode of the leg from one stay to another elsewhere: back into an area he resumes, the way
   * he came (the mode of what closes the stay he leaves); else the destination's.
   */
  #legMode(from: Stay, to: Stay): TravelMode {
    return to.first.softStart ? from.last.anchor.mode : to.first.anchor.mode;
  }

  /** The trip of the leg from one stay to another elsewhere (#legMode). */
  #legTrip(from: Stay, to: Stay): TripKey {
    return DayPlanner.tripKey(from.placeId, to.placeId, this.#legMode(from, to));
  }

  /**
   * The windows of a stay long enough to go home in: none unless going home is on, nor at Home,
   * nor before an area resumes (he is back in it from an item elsewhere).
   */
  #windowsIn(stay: Stay): Window[] {
    const { enabled, minWindowMinutes } = this.#input.settings.goHome;
    if (!enabled || stay.placeId === this.#homeId) return [];
    const windows: Window[] = [];
    // A window starts when every piece before it has ended.
    let freeFrom = stay.first.end.getTime();
    stay.pieces.forEach((after, index) => {
      const before = stay.pieces[index - 1];
      if (before === undefined) return;
      freeFrom = Math.max(freeFrom, before.end.getTime());
      const minutes = (after.start.getTime() - freeFrom) / MS_PER_MINUTE;
      if (minutes < minWindowMinutes || after.softStart) return;
      // Home in the mode of what closes the stay before the window (as its leg home goes).
      const closes = closing(stay.pieces.slice(0, index), freeFrom) ?? before;
      windows.push({
        index,
        minutes,
        home: DayPlanner.tripKey(stay.placeId, this.#homeId, closes.anchor.mode),
        back: DayPlanner.tripKey(this.#homeId, stay.placeId, after.anchor.mode),
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
      stops.push(stayOf(stay.pieces.slice(from, cut)), { kind: 'home' });
      from = cut;
    }
    // The last of them ends the stay, and owes its way home.
    stops.push({ ...stayOf(stay.pieces.slice(from)), wayHome: stay.wayHome });
    return stops;
  }

  /** The legs along the day's stops, before their lengths are known. */
  #legsAlong(stops: readonly Stop[]): LegSpec[] {
    const home = this.#homeId;
    const specs: LegSpec[] = [];
    // The leg into the stop before the one at hand: when he is back in an area, he leaves it once
    // he is there.
    let into: LegSpec | null = null;
    const first = stops[0];
    if (first?.kind === 'stay' && first.placeId !== home && first.first.anchor.there) {
      into = this.#there(first.first.anchor, home, first.placeId, first.start);
      specs.push(into);
    }
    stops.forEach((next, index) => {
      const previous = stops[index - 1];
      if (previous === undefined) return;
      let leg: LegSpec | null = null;
      if (previous.kind === 'stay' && next.kind === 'home') {
        leg = this.#home(previous, into);
      } else if (previous.kind === 'home' && next.kind === 'stay') {
        leg = this.#there(next.first.anchor, home, next.placeId, next.start);
      } else if (
        previous.kind === 'stay' &&
        next.kind === 'stay' &&
        previous.placeId !== next.placeId
      ) {
        const leaving = this.#leaving(previous, into);
        // In #legMode's mode: the trip #visited and trips() read.
        const mode = this.#legMode(previous, next);
        leg = next.first.softStart
          ? {
              // Back into the area around what he leaves, the way he came: as he can, and late
              // only for an appointment waiting there.
              direction: 'back',
              anchor: previous.last.anchor,
              from: previous.placeId,
              to: next.placeId,
              mode,
              ...leaving,
              arriveBy: next.hardStart,
            }
          : {
              // The destination decides the mode: by bus to Braude, then by car on to TLVTech.
              direction: 'between',
              anchor: next.first.anchor,
              from: previous.placeId,
              to: next.placeId,
              mode,
              ...leaving,
              arriveBy: next.start,
            };
      }
      if (leg !== null) specs.push(leg);
      into = leg;
    });
    const last = stops.at(-1);
    if (last?.kind === 'stay' && last.placeId !== home && last.wayHome.back) {
      specs.push(this.#home(last, into));
    }
    return specs;
  }

  /**
   * When he can leave a stay: as its last appointment ends; with none (in an area only), at its
   * start. Back in an area from an item elsewhere, also not before he is there: once that trip is
   * made.
   */
  #leaving(stay: Stay, into: LegSpec | null): Departure {
    if (stay.first.softStart && into !== null && into.direction === 'back') {
      const trip = DayPlanner.tripKey(into.from, into.to, into.mode);
      return {
        leaves: [
          ...into.leaves.map(({ at, after }) => ({ at, after: [...after, trip] })),
          ...(stay.hardEnd === null ? [] : [{ at: stay.hardEnd, after: [] }]),
        ],
      };
    }
    return { leaves: [{ at: stay.hardEnd ?? stay.start, after: [] }] };
  }

  #there(anchor: Located, from: string, to: string, arriveBy: Date): LegSpec {
    return { direction: 'there', anchor, from, to, mode: anchor.mode, arriveBy };
  }

  /**
   * Home from a stay: the way home of whose it is (`wayHome`: its mode and key), as the stay ends,
   * or later if he gets there later.
   */
  #home(stay: Stay, into: LegSpec | null): LegSpec {
    const anchor = stay.wayHome;
    return {
      direction: 'back',
      anchor,
      from: stay.placeId,
      to: this.#homeId,
      mode: anchor.mode,
      leaves: [...this.#leaving(stay, into).leaves, { at: stay.end, after: [] }],
      arriveBy: null,
    };
  }

  /**
   * A leg with its length. There: it arrives as its anchor starts. Back: it leaves as its stay
   * ends (a conflict when it reaches an appointment in the area it returns to late). Between: it
   * arrives by the next stay's start when it can, else it leaves as the stay before ends and is a
   * conflict.
   */
  #timed(spec: LegSpec, length: (trip: TripKey) => Estimate): PlannedLeg {
    const { anchor, from, to, mode } = spec;
    const estimate = length(DayPlanner.tripKey(from, to, mode));
    const span = estimate.minutes * MS_PER_MINUTE;
    const leaves = (departure: Departure): number =>
      Math.max(
        ...departure.leaves.map(({ at, after }) =>
          after.reduce((time, trip) => time + length(trip).minutes * MS_PER_MINUTE, at.getTime()),
        ),
      );
    let start: number;
    let conflict = false;
    switch (spec.direction) {
      case 'there':
        start = spec.arriveBy.getTime() - span;
        break;
      case 'back':
        start = leaves(spec);
        conflict = spec.arriveBy !== null && start + span > spec.arriveBy.getTime();
        break;
      case 'between':
        start = Math.max(spec.arriveBy.getTime() - span, leaves(spec));
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
