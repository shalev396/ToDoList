/**
 * Travel time (docs/superpowers/specs/2026-11-17-travel-time-design.md): the vocabulary of a travel
 * leg, the time TodoList adds to get its member between the places their day happens in. Shared
 * with the client (`@api-types/travel`). Pure.
 *
 * A leg is a local item of kind `travel`, private to its member. What makes it a leg is kept at
 * `props.travel` (TravelLegProps) and its key at `props.travelKey`. Places are named by id and
 * name only: an address or a coordinate is never stored on a leg.
 */

export const TRAVEL_MODES = ['walk', 'drive', 'transit'] as const;
export type TravelMode = (typeof TRAVEL_MODES)[number];

/** To the anchor from Home, back Home from it, or from one place straight to the next. */
export const TRAVEL_DIRECTIONS = ['there', 'back', 'between'] as const;
export type TravelDirection = (typeof TRAVEL_DIRECTIONS)[number];

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
  /** When the anchor starts (ISO), as the leg was planned for it. */
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
 * well formed. The flags default to off and the removal reason to none.
 */
export function travelPropsOf(props: Readonly<Record<string, unknown>>): TravelLegProps | null {
  const raw = props['travel'];
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return null;
  const travel = raw as Record<string, unknown>;
  const { anchorItemId, occurrence, anchorStart, direction, mode, minutes, source } = travel;
  const { fromPlaceId, fromName, toPlaceId, toName, computedAt } = travel;
  const removedReason = travel['removedReason'] ?? null;
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
    (removedReason !== null && !oneOf(REMOVAL_REASONS, removedReason))
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
    removedReason,
  };
}
