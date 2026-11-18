/**
 * Travel time (docs/superpowers/specs/2026-11-17-travel-time-design.md): the vocabulary of a travel
 * leg, the time TodoList adds to get its member between the places their day happens in. Shared
 * with the client (`@api-types/travel`). Pure.
 *
 * A leg is a local item of kind `travel`, private to its member. What makes it a leg is kept at
 * `props.travel` (TravelLegProps) and its key at `props.travelKey`. Places are named by id and
 * name only: an address or a coordinate is never stored on a leg.
 *
 * Also the member's travel settings (factors, buffers, going home in a window, the default mode),
 * the fixed numbers travel runs by, what a travel rule applies to, a place as its member and as an
 * agent see it (an agent: its name only), and what the travel routes (`…/travel/*`) take and
 * answer.
 */
import { z } from 'zod';

import type { RuleGroup } from './builder.js';
import type { ItemDetail, ItemSummary } from './items.js';

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
/** OpenRouteService calls a workspace may make a day, on the free key every member shares. */
export const ROUTING_CALLS_PER_DAY = 100;
/** A geocoded location is at a saved place when it is at most this far from it. */
export const PLACE_MATCH_RADIUS_M = 300;

/**
 * The straight-line estimate, the last fallback: the distance × `detour`, at `kmh`. Public
 * transport's speed is a rough value of ours (plan Ruling 13); the member corrects it by hand.
 */
export const STRAIGHT_LINE: Readonly<
  Record<TravelMode, Readonly<{ kmh: number; detour: number }>>
> = Object.freeze({
  walk: Object.freeze({ kmh: 4.5, detour: 1.3 }),
  drive: Object.freeze({ kmh: 40, detour: 1 }),
  transit: Object.freeze({ kmh: 25, detour: 1.3 }),
});

/** A member's travel settings, the "global variables" of the spec. */
export interface TravelSettings {
  /** A computed length (OpenRouteService, straight line) is multiplied by this, per mode. */
  factors: Record<TravelMode, number>;
  /** Minutes added to a computed length (parking, the walk to the stop), per mode. */
  buffers: Record<TravelMode, number>;
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
  factors: Object.freeze({ walk: 1, drive: 1.15, transit: 1 }),
  buffers: Object.freeze({ walk: 0, drive: 10, transit: 5 }),
  goHome: Object.freeze({ enabled: false, minWindowMinutes: 180, minAtHomeMinutes: 60 }),
  defaultMode: 'transit',
});

const FactorSchema = z.number().min(0.5).max(3);
const BufferSchema = z.number().int().min(0).max(120);

/** Travel settings as given (a whole set): factor 0.5–3, buffer 0–120 minutes. */
export const TravelSettingsSchema = z.strictObject({
  factors: z.strictObject({ walk: FactorSchema, drive: FactorSchema, transit: FactorSchema }),
  buffers: z.strictObject({ walk: BufferSchema, drive: BufferSchema, transit: BufferSchema }),
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
  factors?: Some<Record<TravelMode, number>> | undefined;
  buffers?: Some<Record<TravelMode, number>> | undefined;
  goHome?: Some<TravelSettings['goHome']> | undefined;
  defaultMode?: TravelMode | undefined;
}

/**
 * What a travel rule applies to (plan Ruling 11): the items a where-group (the dashboards' logic
 * builder) matches, every occurrence of one series (keyed on its master item), or one item or
 * occurrence (`occurrence`: its original start as ISO, or `single`). Precedence: item, then
 * series, then where-rules oldest first.
 */
export type TravelRuleScope =
  | { kind: 'where'; where: RuleGroup }
  | { kind: 'series'; itemId: string }
  | { kind: 'item'; itemId: string; occurrence: string };

export type TravelRuleScopeKind = TravelRuleScope['kind'];

/** One of the member's places as their own REST answers show it (never to anyone else). */
export interface PlaceView {
  id: string;
  name: string;
  aliases: string[];
  home: boolean;
  address: string | null;
}

/** A place as an agent sees it: its name only, never an address or a coordinate. */
export interface PlaceAgentView {
  id: string;
  name: string;
  aliases: string[];
  home: boolean;
}

/** Where a leg's length came from: OpenRouteService, the member's last entry, by hand, a guess. */
export const LEG_SOURCES = ['ors', 'remembered', 'manual', 'estimate'] as const;
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
  /** When its length was worked out (ISO). */
  computedAt: string;
  /** It can't be made in time (it starts before the previous anchor ends). */
  conflict: boolean;
  /** The member set its times by hand: regeneration keeps them. */
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
 * well formed. The flags default to off, the removal reason and the anchor's moved start to none.
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
    computedAt,
    conflict: travel['conflict'] === true,
    edited: travel['edited'] === true,
    anchorMoved: travel['anchorMoved'] === true,
    anchorStartNow,
    removedReason,
  };
}

/** An app link for one leg (the client opens `url`, or `fallbackUrl` when the app is missing). */
export interface TravelLink {
  app: 'google_maps' | 'waze' | 'moovit';
  url: string;
  fallbackUrl?: string;
}

// ─── The travel routes (`/api/private/workspaces/:wid/travel/*`) ─────────────
//
// Editors and owners only, each about the caller's own travel: another member's place, rule or
// leg is a 404, as one that never existed. A place's address is in its member's own answers only;
// a coordinate is in none of them (a leg's app links carry the trip's, to its member only).

/** `POST …/travel/places`: coordinates, or an address to look up (`lat, lon` typed is taken as such). */
export interface CreatePlaceRequest {
  name: string;
  address?: string;
  coords?: { lat: number; lon: number };
  aliases?: string[];
  /** Makes it the member's one Home (the old one becomes a plain place). */
  home?: boolean;
}

/** `PATCH …/travel/places/:id`: any of it (an empty `address` clears it and keeps the coordinates). */
export type UpdatePlaceRequest = Partial<CreatePlaceRequest>;

/** A travel rule as its member's own answers show it. */
export interface TravelRuleView {
  id: string;
  scope: TravelRuleScope;
  mode: TravelMode;
  direction: RuleDirection;
  /** The place it sends the member to; null: the anchor's own place. */
  placeId: string | null;
  /** ISO. Where-rules apply oldest first. */
  createdAt: string;
}

/** `POST …/travel/rules`. */
export interface CreateTravelRuleRequest {
  scope: TravelRuleScope;
  mode: TravelMode;
  direction: RuleDirection;
  placeId?: string | null;
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
  /** Whether the stage has an OpenRouteService key (else walking and driving are estimates). */
  orsAvailable: boolean;
}

/** `PUT …/travel/container-places/:containerId` and `PUT …/travel/item-places/:itemId`. */
export interface PlacePinRequest {
  /** One of the member's places; null removes the pin. */
  placeId: string | null;
}

/**
 * One leg's times as the member typed them when marking an item: any two of start, end and length
 * (or one, which keeps the rest).
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
 * start), or an item that doesn't repeat (neither). `there` and `back` are applied to its legs as
 * hand edits (with `every`, a length only: it applies to each occurrence's leg).
 */
export interface MarkItemRequest {
  occurrence?: string;
  every?: boolean;
  mode: TravelMode;
  direction: RuleDirection;
  /** One of the member's places; null or absent: the item's own place. */
  placeId?: string | null;
  there?: SpanInput;
  back?: SpanInput;
}

/** The rule the item is marked with, and its legs in the horizon as they are now. */
export interface MarkItemResponse {
  rule: TravelRuleView;
  legs: ItemDetail[];
}

/**
 * `POST …/travel/preview`: a trip's length as a leg would get it (no leg is made). From defaults
 * to Home; without a place to go to there is no length. `arriveBy` or `departAt` (not both) dates
 * the trip.
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
  startAt: string | null;
  endAt: string | null;
}

/** `PATCH …/travel/legs/:id`: one or two of start, end and length; the rest is worked out. */
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
