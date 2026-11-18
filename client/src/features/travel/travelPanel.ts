/**
 * "Add travel time" (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Where travel comes
 * from"), as pure functions: the panel the create forms and the item sheet share (mode, from, to,
 * there and back, and the trip there: leave, arrive and length, any two set the third), the
 * `POST …/travel/items/:itemId` request it becomes, its preview line, where it starts and goes by
 * default, which items take travel at all, and what a mark's answer means to the member.
 *
 * The trip there arrives by the item's start unless he types otherwise: its arrival and length
 * stand, and the leave time is worked out (`@api-types/timeSpan`). What he never typed is never
 * sent: the server works the trip out (OpenRouteService, his last trip, or an estimate).
 */
import type { TFunction } from 'i18next';
import type { ItemSummary } from '@api-types/items.ts';
import { layerOf } from '@api-types/scheduled.ts';
import {
  derivedField,
  solveSpan,
  touchSpan,
  type Span,
  type SpanField,
} from '@api-types/timeSpan.ts';
import {
  travelPropsOf,
  type LegSource,
  type MarkItemRequest,
  type MarkItemResponse,
  type PlaceView,
  type RuleDirection,
  type SpanInput,
  type TravelMode,
  type TravelPreviewRequest,
  type TravelPreviewResponse,
  type TravelRuleView,
} from '@api-types/travel.ts';
import { placeByName } from '@api-types/travelPlaceNames.ts';
import { dateInZone, instantInZone } from '../items/zonedDate.ts';

export interface TravelPanelState {
  mode: TravelMode;
  /** Where he starts from (the preview's; where a leg starts is the day plan's). */
  fromPlaceId: string | null;
  /** Where he goes: one of his places; null: the item's own place. */
  toPlaceId: string | null;
  there: boolean;
  back: boolean;
  /** The trip there. */
  span: { start: Date | null; end: Date | null; minutes: number | null };
  /** The span fields he typed, most recent first (empty: all of it is worked out). */
  edited: SpanField[];
}

/** Arrive by: the arrival and the length stand unless he types two others; the leave time follows. */
const ARRIVE_BY: readonly SpanField[] = ['end', 'minutes'];

const keptOrder = (edited: readonly SpanField[]): SpanField[] => [...edited, ...ARRIVE_BY];

/** The two fields that stand (the two most recent of his edits, then the arrival and length). */
function keptFields(edited: readonly SpanField[]): SpanField[] {
  const kept: SpanField[] = [];
  for (const field of keptOrder(edited)) {
    if (!kept.includes(field)) {
      kept.push(field);
    }
    if (kept.length === 2) {
      break;
    }
  }
  return kept;
}

/** The whole trip there; null while its two standing fields make none. */
export function panelSpan(state: TravelPanelState): Span | null {
  return solveSpan(state.span, keptOrder(state.edited));
}

/** The worked-out field written from the trip (cleared while there is none). */
function withSolved(state: TravelPanelState): TravelPanelState {
  const field = derivedField(keptOrder(state.edited));
  const span = panelSpan(state);
  const value = span === null ? null : span[field];
  return { ...state, span: { ...state.span, [field]: value } };
}

/** The panel as it opens: both ways, arriving at the item's start, its length not known yet. */
export function initialPanelState(input: {
  mode: TravelMode;
  fromPlaceId: string | null;
  toPlaceId: string | null;
  anchorStart: Date | null;
}): TravelPanelState {
  return withSolved({
    mode: input.mode,
    fromPlaceId: input.fromPlaceId,
    toPlaceId: input.toPlaceId,
    there: true,
    back: true,
    span: { start: null, end: input.anchorStart, minutes: null },
    edited: [],
  });
}

/** He typed one of leave, arrive or length: it stands now, and the oldest one follows. */
export function editPanelSpan(
  state: TravelPanelState,
  field: SpanField,
  value: Date | number | null,
): TravelPanelState {
  return withSolved({
    ...state,
    span: { ...state.span, [field]: value },
    edited: touchSpan(state.edited, field),
  });
}

/** The item's start moved (the new to-do's time): the arrival follows it until he typed one. */
export function anchorPanel(state: TravelPanelState, anchorStart: Date | null): TravelPanelState {
  if (state.edited.includes('end')) {
    return state;
  }
  return withSolved({ ...state, span: { ...state.span, end: anchorStart } });
}

/** The computed length (the preview's) fills the trip until he types any of it. */
export function previewFill(state: TravelPanelState, minutes: number | null): TravelPanelState {
  if (state.edited.length > 0 || state.span.minutes === minutes) {
    return state;
  }
  return withSolved({ ...state, span: { ...state.span, minutes } });
}

/**
 * `HH:MM` typed for the leave or arrive time, on the day of the trip (its arrival's) in the zone.
 * A leave time later than the arrival is the day before. '' clears it.
 */
export function editPanelTime(
  state: TravelPanelState,
  field: 'start' | 'end',
  time: string,
  anchorStart: Date,
  timeZone: string,
): TravelPanelState {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return editPanelSpan(state, field, null);
  }
  const arrival = state.span.end ?? anchorStart;
  let instant = new Date(instantInZone(dateInZone(arrival, timeZone), time, timeZone));
  if (field === 'start' && instant.getTime() >= arrival.getTime()) {
    instant = new Date(instant.getTime() - 24 * 60 * 60_000);
  }
  return editPanelSpan(state, field, instant);
}

export function directionOf(state: Pick<TravelPanelState, 'there' | 'back'>): RuleDirection {
  if (state.there && state.back) {
    return 'both';
  }
  return state.back ? 'back' : 'there';
}

/** The trip there as he typed it: nothing he didn't type, and for every occurrence a length only. */
function thereOf(
  state: TravelPanelState,
  anchorStart: Date,
  every: boolean,
): SpanInput | undefined {
  const span = panelSpan(state);
  if (!state.there || state.edited.length === 0 || span === null) {
    return undefined;
  }
  const kept = keptFields(state.edited);
  // A length that arrives at the item is a length: every occurrence (and a moved item) keeps it.
  const lengthOnly =
    every ||
    (kept.includes('minutes') &&
      kept.includes('end') &&
      span.end.getTime() === anchorStart.getTime());
  const there: SpanInput = lengthOnly
    ? { minutes: span.minutes }
    : {
        ...(kept.includes('start') ? { startAt: span.start.toISOString() } : {}),
        ...(kept.includes('end') ? { endAt: span.end.toISOString() } : {}),
        ...(kept.includes('minutes') ? { minutes: span.minutes } : {}),
      };
  return state.fromPlaceId === null ? there : { ...there, fromPlaceId: state.fromPlaceId };
}

/**
 * The minutes every occurrence would keep when he typed a leave or arrive time of his own: every
 * occurrence takes a length only (each arrives as it starts), so those times would not be kept.
 * Null when nothing typed would be lost.
 */
export function everyKeepsOnlyLength(state: TravelPanelState, anchorStart: Date): number | null {
  const there = thereOf(state, anchorStart, false);
  if (there === undefined || (there.startAt === undefined && there.endAt === undefined)) {
    return null;
  }
  return panelSpan(state)?.minutes ?? null;
}

/**
 * `POST …/travel/items/:itemId`: every occurrence of a series (`every`, no occurrence), one
 * occurrence (its original start), or an item that doesn't repeat (neither). `placeId` null is the
 * item's own place.
 */
export function markRequestOf(
  state: TravelPanelState,
  anchor: { itemId: string; occurrence: Date | null; start: Date },
  every: boolean,
): MarkItemRequest {
  const there = thereOf(state, anchor.start, every);
  return {
    mode: state.mode,
    direction: directionOf(state),
    placeId: state.toPlaceId,
    ...(every
      ? { every: true }
      : anchor.occurrence === null
        ? {}
        : { occurrence: anchor.occurrence.toISOString() }),
    ...(there === undefined ? {} : { there }),
  };
}

// ─── The preview ────────────────────────────────────────────────────────────

/**
 * `POST …/travel/preview` for the trip: by mode and places only (not dated), so a new time costs
 * no routing call and the same trip is asked once. Its own place goes by the guess; without a
 * place to go to there is no length (null: nothing to ask).
 */
export function previewRequestOf(
  state: TravelPanelState,
  ownGuessId: string | null,
): TravelPreviewRequest | null {
  const toPlaceId = state.toPlaceId ?? ownGuessId;
  if (toPlaceId === null) {
    return null;
  }
  return {
    mode: state.mode,
    ...(state.fromPlaceId === null ? {} : { fromPlaceId: state.fromPlaceId }),
    toPlaceId,
  };
}

/** The trip there as the preview line shows it. */
export interface PanelPreview {
  start: Date;
  end: Date;
  minutes: number;
  source: LegSource;
}

/** His times once he typed any; else the computed length, with where it came from. */
export function panelPreview(
  state: TravelPanelState,
  answer: TravelPreviewResponse | undefined,
): PanelPreview | null {
  const span = panelSpan(state);
  if (span === null) {
    return null;
  }
  const source: LegSource | null = state.edited.length > 0 ? 'manual' : (answer?.source ?? null);
  return source === null ? null : { ...span, source };
}

/** "13:20" kept left to right inside a Hebrew line. */
const ltr = (text: string): string => `⁦${text}⁩`;

/** "Leave 13:20 · arrive 13:52 · 32 min (OpenRouteService)". */
export function previewLine(
  t: TFunction,
  preview: PanelPreview,
  clock: { locale: string; timeZone: string } = { locale: 'en-GB', timeZone: 'UTC' },
): string {
  const time = (date: Date) =>
    new Intl.DateTimeFormat(clock.locale, {
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23',
      timeZone: clock.timeZone,
    }).format(date);
  return t('travel.add.preview.line', {
    start: ltr(time(preview.start)),
    end: ltr(time(preview.end)),
    minutes: Math.round(preview.minutes),
    source: t(`travel.add.preview.sources.${preview.source}`),
  });
}

// ─── Where from, where to ───────────────────────────────────────────────────

/** The member's Home; null while he has none (travel needs one). */
export function homeOf(places: readonly PlaceView[]): PlaceView | null {
  return places.find((place) => place.home) ?? null;
}

const instant = (value: Date | string | null): number =>
  value === null ? Number.NaN : new Date(value).getTime();

/**
 * From: where the day plan has him before the item (the place his last leg that day takes him
 * to, before the item starts; its own legs aside), else Home; null without either.
 */
export function defaultFromPlace(
  places: readonly PlaceView[],
  legs: readonly ItemSummary[],
  anchorStart: Date,
  anchorItemId: string | null,
): string | null {
  const home = homeOf(places)?.id ?? null;
  let last: { end: number; to: string | null } | null = null;
  for (const leg of legs) {
    const travel = travelPropsOf(leg.props);
    const end = instant(leg.endAt);
    // A removed leg, or one of the item's own (by its id, or planned for its very start), is no
    // place before it.
    if (
      travel?.removedReason !== null ||
      travel.anchorItemId === anchorItemId ||
      new Date(travel.anchorStart).getTime() === anchorStart.getTime() ||
      !(end <= anchorStart.getTime())
    ) {
      continue;
    }
    if (last === null || end > last.end) {
      last = { end, to: travel.toHome ? home : travel.toPlaceId };
    }
  }
  const before = last?.to ?? null;
  return before !== null && places.some((place) => place.id === before) ? before : home;
}

/** Whether the item has a place of its own (a location, or its calendar's default), and which. */
export interface OwnPlace {
  offered: boolean;
  /** The place the server would most likely find (by name, or the default place); null: unknown. */
  guess: PlaceView | null;
}

export function ownPlaceOf(
  item: { props: Readonly<Record<string, unknown>>; containerId: string | null },
  places: readonly PlaceView[],
  containerPlaces: readonly { containerId: string; placeId: string }[],
): OwnPlace {
  const location = item.props['location'];
  const named =
    typeof location === 'string' && location.trim() !== '' ? placeByName(location, places) : null;
  const pinned = containerPlaces.find((entry) => entry.containerId === item.containerId);
  const byDefault =
    pinned === undefined ? null : (places.find((place) => place.id === pinned.placeId) ?? null);
  const offered = (typeof location === 'string' && location.trim() !== '') || byDefault !== null;
  return { offered, guess: named ?? byDefault };
}

/** A to-do or a block has no place of its own: it goes to a place picked in the panel. */
export const NO_OWN_PLACE: OwnPlace = Object.freeze({ offered: false, guess: null });

/** To: the item's own place when it has one; else a saved place (not Home); else none. */
export function defaultToPlace(places: readonly PlaceView[], own: OwnPlace): string | null {
  if (own.offered) {
    return null;
  }
  return places.find((place) => !place.home)?.id ?? null;
}

/** What the panel opens on: the member's places, his Home and his default mode. */
export interface TravelSetupView {
  places: readonly PlaceView[];
  home: PlaceView | null;
  defaultMode: TravelMode;
}

/** The panel as it opens on an item: the default mode, from Home, to its place or a saved one. */
export function openPanel(
  setup: TravelSetupView,
  own: OwnPlace,
  anchorStart: Date | null,
): TravelPanelState {
  return initialPanelState({
    mode: setup.defaultMode,
    fromPlaceId: setup.home?.id ?? null,
    toPlaceId: defaultToPlace(setup.places, own),
    anchorStart,
  });
}

// ─── Which items, their mark, and the answer ────────────────────────────────

/**
 * A timed item travel can get you to (the server's own rule): a start, not all day, not
 * cancelled, never a travel leg, and never an area (painted time is not travelled to).
 */
export function canTravelTo(item: {
  kind: string;
  startAt: Date | string | null;
  allDay: boolean;
  status: string;
  props: Readonly<Record<string, unknown>>;
}): boolean {
  return (
    item.startAt !== null &&
    !item.allDay &&
    item.status !== 'cancelled' &&
    item.kind !== 'travel' &&
    layerOf(item) !== 'area'
  );
}

/**
 * What the server keeps an item's marks under (TravelRule's mark scope): a moved occurrence of a
 * repeating event (its own row) under its series and original start (`seriesOccurrence`); any
 * other item under its own id, on the occurrence the sheet is on (null: the item as a whole).
 */
export function markTargetOf(
  item: { id: string; seriesOccurrence?: { seriesId: string; originalStart: string } | undefined },
  occurrence: Date | null,
): { itemId: string; slot: Date | null } {
  const series = item.seriesOccurrence;
  return series === undefined
    ? { itemId: item.id, slot: occurrence }
    : { itemId: series.seriesId, slot: new Date(series.originalStart) };
}

/** The item's own mark: this occurrence's (or the item's) first, then its series'. */
export function markOf(
  rules: readonly TravelRuleView[],
  itemId: string,
  occurrence: Date | null,
): TravelRuleView | null {
  const slot = occurrence === null ? 'single' : occurrence.toISOString();
  const own = rules.find(
    ({ scope }) => scope.kind === 'item' && scope.itemId === itemId && scope.occurrence === slot,
  );
  const series = rules.find(({ scope }) => scope.kind === 'series' && scope.itemId === itemId);
  return own ?? series ?? null;
}

/** What a mark came to, for the member. */
export type TravelOutcome =
  | { kind: 'added'; count: number }
  /** Stored, with no trips yet (its place isn't known yet, or they come with the next sync). */
  | { kind: 'pending'; ownPlace: boolean };

/** The text of what a mark came to (a toast, the item sheet's note). */
export function outcomeText(t: TFunction, outcome: TravelOutcome): string {
  switch (outcome.kind) {
    case 'added':
      return t('travel.add.added', { count: outcome.count });
    case 'pending':
      return outcome.ownPlace
        ? `${t('travel.add.pending')} ${t('travel.add.pendingOwnPlace')}`
        : t('travel.add.pending');
  }
}

/** An answer with no trips is a calm note, never an error. */
export function outcomeOf(answer: MarkItemResponse, ownPlace: boolean): TravelOutcome {
  return answer.legs.length > 0
    ? { kind: 'added', count: answer.legs.length }
    : { kind: 'pending', ownPlace };
}
