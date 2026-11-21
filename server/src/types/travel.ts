/**
 * Travel time (docs/superpowers/specs/2026-11-17-travel-time-design.md): the vocabulary of a travel
 * leg, the time TodoList adds to get its member between the places their day happens in. Shared
 * with the client (`@api-types/travel`). Pure.
 *
 * A leg is a local item of kind `travel`, private to its member. What makes it a leg is kept at
 * `props.travel` (TravelLegProps) and its key at `props.travelKey`. Places are named by id and
 * name only: an address is never stored on a leg.
 *
 * A trip's length is the member's own (the owner's decision of 2026-11-18: no routing service):
 * one number per trip (from place, to place, mode) that he sets once, and that every leg of that
 * trip takes, every day and every occurrence. A trip without one is drawn with UNSET_TRIP_MINUTES
 * and flagged `lengthUnset` until he sets it.
 *
 * Also the member's travel settings (going home in a window, the default mode), the fixed numbers
 * travel runs by, what a travel rule applies to, a place as its member and as an agent see it (an
 * agent: its name only), and what the travel routes (`…/travel/*`) take and answer.
 */
import { z } from 'zod';

import type { RuleGroup } from './builder.js';
import type { ItemDetail, ItemSummary } from './items.js';
import type { RepeatsScope } from './travelRepeats.js';

export const TRAVEL_MODES = ['walk', 'drive', 'transit'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

/** To the anchor from Home, back Home from it, or from one place straight to the next. */
export const TRAVEL_DIRECTIONS = ['there', 'back', 'between'] as const;
export type TravelDirection = (typeof TRAVEL_DIRECTIONS)[number];

/** What a rule asks for: the day's first leg (there), its last (back), or both. */
export const RULE_DIRECTIONS = ['there', 'back', 'both'] as const;
export type RuleDirection = (typeof RULE_DIRECTIONS)[number];

/** Legs exist for this many days ahead, and are made again as days come into range. */
export const TRAVEL_HORIZON_DAYS = 14;
/** The most days one read of the day panel (`GET …/travel/days`) covers. */
export const TRAVEL_DAYS_MAX = TRAVEL_HORIZON_DAYS;

/**
 * The length a trip is drawn with until its member sets one, the same for every mode: its legs are
 * made with it, take part in conflicts with it, and ask "Set how long".
 */
export const UNSET_TRIP_MINUTES = 30;
/** The longest trip: a day, in minutes. */
export const TRIP_MINUTES_MAX = 24 * 60;
/** The most a rule's `arriveEarlyMinutes` can be: four hours. */
export const ARRIVE_EARLY_MAX = 240;

/**
 * The trip lengths a rule sets for the legs it draws, in whole minutes (more than 0, at most
 * TRIP_MINUTES_MAX): `there` for the leg that gets him to the anchor, `back` for the anchor's way
 * back (home, or back into the area around it). A side left out takes its trip's own length.
 */
export interface RuleLengths {
  there?: number;
  back?: number;
}

/** Lengths as a caller gives them: a side that is null (or left out) takes the trip's own. */
export interface RuleLengthsInput {
  there?: number | null | undefined;
  back?: number | null | undefined;
}

/** A member's travel settings, the "global variables" of the spec. */
export interface TravelSettings {
  /**
   * Go home in a window between two events at one place: only a window of at least
   * `minWindowMinutes` that leaves at least `minAtHomeMinutes` at home after the trips both ways.
   */
  goHome: { enabled: boolean; minWindowMinutes: number; minAtHomeMinutes: number };
  /** The mode a new rule or manual travel starts on. */
  defaultMode: TravelMode;
}

/** The spec's defaults (Concepts, 5). Frozen: copy it to change it. */
export const DEFAULT_TRAVEL_SETTINGS: Readonly<TravelSettings> = Object.freeze({
  goHome: Object.freeze({ enabled: false, minWindowMinutes: 180, minAtHomeMinutes: 60 }),
  defaultMode: 'transit',
});

/** Travel settings as given (a whole set). */
export const TravelSettingsSchema = z.strictObject({
  goHome: z.strictObject({
    enabled: z.boolean(),
    minWindowMinutes: z.number().int().min(180),
    minAtHomeMinutes: z.number().int().min(60),
  }),
  defaultMode: z.enum(TRAVEL_MODES),
}) satisfies z.ZodType<TravelSettings>;

/** Any of a record's values; one left out (or undefined) stays as it is. */
type Some<T> = { [K in keyof T]?: T[K] | undefined };

/** A change to the settings: any part of them; what is left out stays as it is. */
export interface TravelSettingsPatch {
  goHome?: Some<TravelSettings['goHome']> | undefined;
  defaultMode?: TravelMode | undefined;
}

/**
 * What a travel rule applies to (plan Ruling 11): the items a where-group (the dashboards' logic
 * builder) matches, every occurrence of one series (keyed on its master item), one item or
 * occurrence (`occurrence`: its original start as ISO, or `single`), or the repeats of an event
 * that doesn't repeat by itself (`repeats`: the events of one calendar or project with one title
 * on one weekday at one local time, from one start on, later imports too). Precedence: item, then
 * series, then repeats, then where-rules oldest first.
 */
export type TravelRuleScope =
  | { kind: 'where'; where: RuleGroup }
  | { kind: 'series'; itemId: string }
  | { kind: 'item'; itemId: string; occurrence: string }
  | RepeatsScope;

export type TravelRuleScopeKind = TravelRuleScope['kind'];

/**
 * One of the member's places as their own REST answers show it (never to anyone else): its name,
 * and the address he typed for it, if any (free text, used only to open a map app on his device).
 */
export interface PlaceView {
  id: string;
  name: string;
  aliases: string[];
  home: boolean;
  address: string | null;
}

/** A place as an agent sees it: its name only, never an address. */
export interface PlaceAgentView {
  id: string;
  name: string;
  aliases: string[];
  home: boolean;
}

/**
 * Where a leg's length came from: `set` by the member (the trip's length, or his own times for
 * this leg), or `unset`: the trip has no length yet, and the leg is drawn with UNSET_TRIP_MINUTES.
 */
export const LEG_SOURCES = ['set', 'unset'] as const;
export type LegSource = (typeof LEG_SOURCES)[number];

/** Why a leg went (a removed leg stays as a tombstone with its reason; a skip is one). */
export const REMOVAL_REASONS = [
  'cancelled',
  'moved',
  'no_longer_matches',
  'no_place',
  'replaced',
  'skipped',
] as const;
export type RemovalReason = (typeof REMOVAL_REASONS)[number];

/** What makes a leg (`props.travel`). Its times are the item's own `startAt` and `endAt`. */
export interface TravelLegProps {
  /** The item it gets the member to or from (a series' master, for an occurrence of a series). */
  anchorItemId: string;
  /** The anchor occurrence's original start (ISO), or `single` for an item that doesn't repeat. */
  occurrence: string;
  /**
   * When the anchor starts (ISO), as the leg was planned for it. On a leg the member edited, the
   * start his times were last set against.
   */
  anchorStart: string;
  direction: TravelDirection;
  mode: TravelMode;
  fromPlaceId: string;
  /** The place's name, for titles and views (never its address). */
  fromName: string;
  toPlaceId: string;
  toName: string;
  /** The leg starts at the member's Home ("Bus to Braude"). */
  fromHome: boolean;
  /** The leg ends at the member's Home ("Bus home"). */
  toHome: boolean;
  minutes: number;
  source: LegSource;
  /**
   * The trip has no length yet (source `unset`): the leg is drawn with UNSET_TRIP_MINUTES, dashed,
   * and asks "Set how long". Read from `source`.
   */
  lengthUnset: boolean;
  /** When its length was worked out (ISO). */
  computedAt: string;
  /** It can't be made in time (it starts before the previous anchor ends). */
  conflict: boolean;
  /** The member set this leg's times by hand: regeneration keeps them until he resets it. */
  edited: boolean;
  /** Its anchor moved since the member edited it ("the event moved; check this trip"). */
  anchorMoved: boolean;
  /**
   * While `anchorMoved`: when the anchor starts now (ISO). His next edit of the leg is made against
   * it, so the edit acknowledges the move (it becomes `anchorStart` and the flag clears). Null
   * otherwise.
   */
  anchorStartNow: string | null;
  /** Set on a removed leg's tombstone; null while it is live. */
  removedReason: RemovalReason | null;
}

function oneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === 'string' && (values as readonly string[]).includes(value);
}

const isText = (value: unknown): value is string => typeof value === 'string' && value !== '';

const isInstant = (value: unknown): value is string =>
  typeof value === 'string' && !Number.isNaN(new Date(value).getTime());

/**
 * A leg's travel props, read from its item's props: null unless every field it needs is there and
 * well formed. The flags default to off, the removal reason and the anchor's moved start to none;
 * `lengthUnset` follows the source.
 */
export function travelPropsOf(props: Readonly<Record<string, unknown>>): TravelLegProps | null {
  const raw = props['travel'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const travel = raw as Record<string, unknown>;
  const { anchorItemId, occurrence, anchorStart, direction, mode, minutes, source } = travel;
  const { fromPlaceId, fromName, toPlaceId, toName, computedAt } = travel;
  const removedReason = travel['removedReason'] ?? null;
  const anchorStartNow = travel['anchorStartNow'] ?? null;
  if (
    !isText(anchorItemId) ||
    !isText(occurrence) ||
    !isInstant(anchorStart) ||
    !oneOf(TRAVEL_DIRECTIONS, direction) ||
    !oneOf(TRAVEL_MODES, mode) ||
    !isText(fromPlaceId) ||
    typeof fromName !== 'string' ||
    !isText(toPlaceId) ||
    typeof toName !== 'string' ||
    typeof minutes !== 'number' ||
    !Number.isFinite(minutes) ||
    minutes < 0 ||
    !oneOf(LEG_SOURCES, source) ||
    !isInstant(computedAt) ||
    (removedReason !== null && !oneOf(REMOVAL_REASONS, removedReason)) ||
    (anchorStartNow !== null && !isInstant(anchorStartNow))
  ) {
    return null;
  }
  return {
    anchorItemId,
    occurrence,
    anchorStart,
    direction,
    mode,
    fromPlaceId,
    fromName,
    toPlaceId,
    toName,
    fromHome: travel['fromHome'] === true,
    toHome: travel['toHome'] === true,
    minutes,
    source,
    lengthUnset: source === 'unset',
    computedAt,
    conflict: travel['conflict'] === true,
    edited: travel['edited'] === true,
    anchorMoved: travel['anchorMoved'] === true,
    anchorStartNow,
    removedReason,
  };
}

/** An app link for one leg: Waze (driving) or Google Maps directions, from the places' text. */
export interface TravelLink {
  app: 'google_maps' | 'waze';
  url: string;
}

// ─── The travel routes (`/api/private/workspaces/:wid/travel/*`) ─────────────
//
// Editors and owners only, each about the caller's own travel: another member's place, rule or
// leg is a 404, as one that never existed. A place's address is in its member's own answers only
// (and in a leg's app links, to its member only); nothing is ever looked up from it.

/**
 * `POST …/travel/places`: a name, and an address if he wants one (free text, never looked up: it
 * only opens a map app; a typed "lat, lon" is text like any other).
 */
export interface CreatePlaceRequest {
  name: string;
  address?: string;
  aliases?: string[];
  /** Makes it the member's one Home (the old one becomes a plain place). */
  home?: boolean;
}

/** `PATCH …/travel/places/:id`: any of it (an empty `address` clears it). */
export type UpdatePlaceRequest = Partial<CreatePlaceRequest>;

/** A travel rule as its member's own answers show it. */
export interface TravelRuleView {
  id: string;
  scope: TravelRuleScope;
  mode: TravelMode;
  direction: RuleDirection;
  /** The place it sends the member to; null: the anchor's own place. */
  placeId: string | null;
  /** The "there" leg arrives this many whole minutes (0 to ARRIVE_EARLY_MAX) before the anchor; null: 0. */
  arriveEarlyMinutes: number | null;
  /** Lengths that win over the trip's own for the legs this rule draws; null: none. */
  lengths: RuleLengths | null;
  /** ISO. Where-rules apply oldest first. */
  createdAt: string;
}

/** `POST …/travel/rules`. */
export interface CreateTravelRuleRequest {
  scope: TravelRuleScope;
  mode: TravelMode;
  direction: RuleDirection;
  placeId?: string | null;
  arriveEarlyMinutes?: number | null;
  lengths?: RuleLengthsInput | null;
}

/** `PATCH …/travel/rules/:id`: any of it. */
export type UpdateTravelRuleRequest = Partial<CreateTravelRuleRequest>;

/** `PATCH …/travel/settings`: any part of the settings; what is left out stays as it is. */
export type UpdateTravelSettingsRequest = TravelSettingsPatch;

/** `GET` and `PATCH …/travel/settings`. */
export interface TravelSettingsResponse {
  settings: TravelSettings;
  /** The default places of calendars and projects, by container id. */
  containerPlaces: { containerId: string; placeId: string }[];
}

/** `PUT …/travel/container-places/:containerId` and `PUT …/travel/item-places/:itemId`. */
export interface PlacePinRequest {
  /** One of the member's places; null removes the pin. */
  placeId: string | null;
}

/**
 * One leg as the member typed it when marking an item: `minutes` is how long the trip takes, every
 * time (the trip's length: every leg of it follows); `startAt` and `endAt` move this leg only (one
 * alone keeps its length).
 */
export interface SpanInput {
  startAt?: string;
  endAt?: string;
  minutes?: number;
  /**
   * The place he picked to start from: checked to be one of his places (400 otherwise), but where
   * a leg starts comes from the day plan (Home, or the place before), never from this.
   */
  fromPlaceId?: string | null;
}

/**
 * `POST …/travel/items/:itemId`: travel to (and from) one timed item. Every occurrence of a
 * repeating item (`every`: a series rule), one occurrence of it (`occurrence`, its original
 * start), or an item that doesn't repeat (neither). In `there`, `minutes` is how long the trip he
 * names takes, every time: from `there.fromPlaceId` (else Home) to `placeId` (else the item's own
 * place), by `mode`; in `back`, that trip reversed. It is set whether or not the item has legs yet
 * (every leg of the trip follows; the way back starts the same when it has no length). Times move
 * that one leg (with `every`, a length only).
 */
export interface MarkItemRequest {
  occurrence?: string;
  every?: boolean;
  mode: TravelMode;
  direction: RuleDirection;
  /** One of the member's places; null or absent: the item's own place. */
  placeId?: string | null;
  /** The rule's `arriveEarlyMinutes` (null clears it; absent keeps it). */
  arriveEarlyMinutes?: number | null;
  /** The rule's `lengths` (null clears them; absent keeps them). */
  lengths?: RuleLengthsInput | null;
  there?: SpanInput;
  back?: SpanInput;
}

/**
 * A marked item with no trips of its own because it sits inside a marked area at the area's place
 * (its own, or the one it takes from the area): the area's title and the place's name.
 */
export interface WithinArea {
  area: string;
  place: string;
}

/**
 * The rule the item is marked with, and its legs in the horizon as they are now. With no legs,
 * `within` names the marked area it is spent in, when that is why (else null).
 */
export interface MarkItemResponse {
  rule: TravelRuleView;
  legs: ItemDetail[];
  within: WithinArea | null;
  /**
   * The length typed with the mark: true when it was set for the trip it names; false when it was
   * not stored, since the item's own place isn't known yet; null when none was typed.
   */
  lengthStored: boolean | null;
}

/** How far a mode change reaches: this trip's event only, or every repeat of it. */
export const LEG_MODE_SCOPES = ['this', 'repeats'] as const;
export type LegModeScope = (typeof LEG_MODE_SCOPES)[number];

/**
 * `PUT …/travel/legs/:id/mode`: how he goes on this leg's event. `this`: that one occurrence;
 * `repeats`: every occurrence of a repeating event, or, for an event that doesn't repeat (an
 * imported timetable), it and every later event of the same calendar or project with the same
 * title, weekday and local start time.
 */
export interface LegModeRequest {
  mode: TravelMode;
  scope: LegModeScope;
}

/**
 * How many rules were stored (1: "every repeat" is one rule, however many events it reaches; 0 when a rule of the same pattern and way already makes the trip), and the leg as it is after the legs were made again (the same
 * anchor, occurrence and direction); null when there is none now.
 */
export interface LegModeResponse {
  marked: number;
  leg: ItemDetail | null;
}

/**
 * `POST …/travel/preview`: a trip's length as a leg would get it (no leg is made): the length he
 * set for it, else UNSET_TRIP_MINUTES with `lengthUnset`. From defaults to Home; without a place to
 * go to there is no length. `arriveBy` or `departAt` (not both) dates the trip.
 */
export interface TravelPreviewRequest {
  mode: TravelMode;
  fromPlaceId?: string;
  toPlaceId?: string;
  arriveBy?: string;
  departAt?: string;
}

/** The trip's length and where it came from; null when it has none. Times ISO. */
export interface TravelPreviewResponse {
  minutes: number | null;
  source: LegSource | null;
  /** No length is set for the trip yet: `minutes` is UNSET_TRIP_MINUTES. */
  lengthUnset: boolean;
  startAt: string | null;
  endAt: string | null;
}

/**
 * `PATCH …/travel/legs/:id`: `minutes` sets how long the trip takes, every time (every leg of the
 * trip follows, but the ones whose times he set by hand); `startAt` and `endAt` move this leg only
 * (one alone keeps its length). At least one of them.
 */
export interface LegEditRequest {
  startAt?: string;
  endAt?: string;
  minutes?: number;
}

/** `GET …/travel/legs/:id/links`: the apps that open the trip (its member only). */
export interface TravelLinksResponse {
  links: TravelLink[];
}

/** A removed leg in the day panel: why it went, and when. */
export interface RemovedLegView {
  id: string;
  title: string;
  reason: RemovalReason;
  /** ISO. */
  removedAt: string;
  /**
   * What the trip was, so a view can word its title in its own language: the mode, whether it went
   * home, and the place it went to by name (never an address). Absent when the stored props are
   * not a leg's.
   */
  mode?: TravelMode;
  toHome?: boolean;
  toName?: string;
}

/** One day of the member's travel (a leg is on the day it starts, in the workspace's zone). */
export interface TravelDayView {
  /** `YYYY-MM-DD`. */
  date: string;
  legs: ItemSummary[];
  removed: RemovedLegView[];
}

/** `GET …/travel/days?from=YYYY-MM-DD&to=YYYY-MM-DD`: every day from `from` to `to`, at most 14. */
export interface TravelDaysResponse {
  days: TravelDayView[];
}
