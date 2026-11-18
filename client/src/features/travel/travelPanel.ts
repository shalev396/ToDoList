/**
 * "Add travel time" (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Where travel comes
 * from", as the owner's decision of 2026-11-18 amends it), as pure functions: the panel the create
 * forms, the item sheet and a leg's sheet share (mode, from, to, there and back, and the trip
 * there), the `POST …/travel/items/:itemId` and `PATCH …/travel/legs/:id` requests it becomes, its
 * preview line, where it starts and goes by default, which items take travel at all, and what a
 * mark's answer means to the member.
 *
 * Two kinds of change, kept apart so he always knows which one he makes:
 * - how long the trip takes, every time (`minutes`): the trip's length (from place, to place,
 *   mode), which every leg of that trip takes; until he sets one it is drawn with
 *   UNSET_TRIP_MINUTES and says "Set how long";
 * - leave and arrive: this trip only. One alone keeps the trip's length; both are its span.
 *
 * A trip there arrives by the item's start (a trip back leaves as it ends) unless he types a time.
 * What he never typed is never sent.
 */
import type { TFunction } from 'i18next';
import type { ItemSummary } from '@api-types/items.ts';
import type { Span } from '@api-types/timeSpan.ts';
import { toDate } from '@api-types/recurrence/occurrences.ts';
import {
  TRIP_MINUTES_MAX,
  UNSET_TRIP_MINUTES,
  travelPropsOf,
  type LegEditRequest,
  type LegSource,
  type MarkItemRequest,
  type MarkItemResponse,
  type PlaceView,
  type RuleDirection,
  type SpanInput,
  type TravelLegProps,
  type TravelMode,
  type TravelPreviewRequest,
  type TravelPreviewResponse,
  type TravelRuleView,
} from '@api-types/travel.ts';
import { placeByName } from '@api-types/travelPlaceNames.ts';
import { dateInZone, instantInZone } from '../items/zonedDate.ts';

const MINUTE_MS = 60_000;

export interface TravelPanelState {
  mode: TravelMode;
  /** Where he starts from (the preview's; where a leg starts is the day plan's). */
  fromPlaceId: string | null;
  /** Where he goes: one of his places; null: the item's own place. */
  toPlaceId: string | null;
  there: boolean;
  back: boolean;
  /**
   * How long the trip takes, every time: as he typed it, else the trip's own (the preview's);
   * null while it has none (it is drawn with UNSET_TRIP_MINUTES).
   */
  minutes: number | null;
  /** He typed the length: it is sent, and becomes the trip's. */
  lengthTyped: boolean;
  /** This trip's leave and arrive, as he typed them; null: not typed (it follows). */
  start: Date | null;
  end: Date | null;
  /**
   * Where the trip is held until he types a time: a trip there arrives by it (the item's start, or
   * a leg's arrival), a trip back leaves at it (`keepsDeparture`).
   */
  anchor: Date | null;
  keepsDeparture?: boolean;
  /**
   * A leg's own length (its sheet): its times stay its own until he types; null on the add panel,
   * where the trip's length (or the placeholder) makes the times.
   */
  ownMinutes?: number | null;
}

/** A length he can type: whole minutes, more than none and at most a day; else null. */
export function lengthFromInput(text: string): number | null {
  if (!/^\d{1,4}$/.test(text.trim())) {
    return null;
  }
  const minutes = Number(text.trim());
  return minutes > 0 && minutes <= TRIP_MINUTES_MAX ? minutes : null;
}

/** The trip's length, every time, as he typed it (null: not typed, or nothing to send). */
function typedLength(state: TravelPanelState): number | null {
  return state.lengthTyped ? state.minutes : null;
}

/** The length this trip's times are drawn with: typed, the leg's own, the trip's, the placeholder. */
function drawnMinutes(state: TravelPanelState): number {
  return typedLength(state) ?? state.ownMinutes ?? state.minutes ?? UNSET_TRIP_MINUTES;
}

/**
 * This trip's span as the panel shows it: both times he typed; one of them and the length; else
 * held at its anchor with the length. Null without an anchor, or when what he typed makes no trip.
 */
export function panelSpan(state: TravelPanelState): Span | null {
  const length = drawnMinutes(state) * MINUTE_MS;
  let start: number;
  let end: number;
  if (state.start !== null && state.end !== null) {
    start = state.start.getTime();
    end = state.end.getTime();
  } else if (state.start !== null) {
    start = state.start.getTime();
    end = start + length;
  } else if (state.end !== null) {
    end = state.end.getTime();
    start = end - length;
  } else if (state.anchor === null) {
    return null;
  } else if (state.keepsDeparture === true) {
    start = state.anchor.getTime();
    end = start + length;
  } else {
    end = state.anchor.getTime();
    start = end - length;
  }
  if (!(end > start)) {
    return null;
  }
  return { start: new Date(start), end: new Date(end), minutes: (end - start) / MINUTE_MS };
}

/** Whether the trip's length isn't set yet (nor typed): its times are drawn with the placeholder. */
function lengthUnset(state: TravelPanelState): boolean {
  return state.minutes === null && (state.ownMinutes ?? null) === null;
}

/** The panel as it opens: both ways, arriving at the item's start, its length not known yet. */
export function initialPanelState(input: {
  mode: TravelMode;
  fromPlaceId: string | null;
  toPlaceId: string | null;
  anchorStart: Date | null;
}): TravelPanelState {
  return {
    mode: input.mode,
    fromPlaceId: input.fromPlaceId,
    toPlaceId: input.toPlaceId,
    there: true,
    back: true,
    minutes: null,
    lengthTyped: false,
    start: null,
    end: null,
    anchor: input.anchorStart,
  };
}

/**
 * He typed how long the trip takes, every time (null: cleared, or not a length): the trip's times
 * follow it, but what he typed of them.
 */
export function editPanelLength(state: TravelPanelState, minutes: number | null): TravelPanelState {
  return { ...state, minutes, lengthTyped: true };
}

/** The item's start moved (the new to-do's time): the trip follows it until he typed a time. */
export function anchorPanel(state: TravelPanelState, anchorStart: Date | null): TravelPanelState {
  return { ...state, anchor: anchorStart };
}

/**
 * The trip's own length (the preview's answer) fills the length until he types one: the length
 * he set for the trip, or none while it is not set yet.
 */
export function previewFill(
  state: TravelPanelState,
  answer: TravelPreviewResponse | undefined,
): TravelPanelState {
  if (state.lengthTyped || answer === undefined) {
    return state;
  }
  const minutes = answer.lengthUnset ? null : answer.minutes;
  return state.minutes === minutes ? state : { ...state, minutes };
}

/**
 * `HH:MM` typed for the leave or arrive time of this trip, on the day of the trip (its arrival's)
 * in the zone. A leave time later than the arrival is the day before. '' clears it (it follows
 * again).
 */
export function editPanelTime(
  state: TravelPanelState,
  field: 'start' | 'end',
  time: string,
  timeZone: string,
): TravelPanelState {
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return { ...state, [field]: null };
  }
  const arrival = state.end ?? panelSpan(state)?.end ?? state.anchor;
  if (arrival === null) {
    return state;
  }
  let instant = new Date(instantInZone(dateInZone(arrival, timeZone), time, timeZone));
  if (field === 'start' && instant.getTime() >= arrival.getTime()) {
    instant = new Date(instant.getTime() - 24 * 60 * 60_000);
  }
  return { ...state, [field]: instant };
}

export function directionOf(state: Pick<TravelPanelState, 'there' | 'back'>): RuleDirection {
  if (state.there && state.back) {
    return 'both';
  }
  return state.back ? 'back' : 'there';
}

/**
 * The trip there as he typed it: the length (the trip's, every time) and the times he typed (this
 * trip's). An arrival he typed as the item's own start is no time of his. Every occurrence takes a
 * length only.
 */
function thereOf(state: TravelPanelState, every: boolean): SpanInput | undefined {
  if (!state.there) {
    return undefined;
  }
  const minutes = typedLength(state);
  const startAt = every ? null : state.start;
  const arrival = every ? null : state.end;
  const endAt =
    arrival !== null &&
    startAt === null &&
    state.anchor !== null &&
    arrival.getTime() === state.anchor.getTime()
      ? null
      : arrival;
  if (minutes === null && startAt === null && endAt === null) {
    return undefined;
  }
  if (startAt !== null && endAt !== null && panelSpan(state) === null) {
    return undefined;
  }
  const there: SpanInput = {
    ...(startAt === null ? {} : { startAt: startAt.toISOString() }),
    ...(endAt === null ? {} : { endAt: endAt.toISOString() }),
    ...(minutes === null ? {} : { minutes }),
  };
  return state.fromPlaceId === null ? there : { ...there, fromPlaceId: state.fromPlaceId };
}

/**
 * What every occurrence would not keep of what he typed: the leave and arrive times are this
 * trip's own, and every occurrence takes a length only. The length kept (null: none typed), or
 * undefined when nothing typed would be lost.
 */
export function everyDropsTimes(state: TravelPanelState): { minutes: number | null } | undefined {
  const one = thereOf(state, false);
  if (one === undefined || (one.startAt === undefined && one.endAt === undefined)) {
    return undefined;
  }
  return { minutes: typedLength(state) };
}

/**
 * `POST …/travel/items/:itemId`: every occurrence of a series (`every`, no occurrence), one
 * occurrence (its original start), or an item that doesn't repeat (neither). `placeId` null is the
 * item's own place.
 */
export function markRequestOf(
  state: TravelPanelState,
  anchor: { occurrence: Date | null },
  every: boolean,
): MarkItemRequest {
  const there = thereOf(state, every);
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
 * `POST …/travel/preview` for the trip: by mode and places only (not dated), so a new time asks
 * nothing new and the same trip is asked once. Its own place goes by the guess; without a place to
 * go to there is no length (null: nothing to ask).
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

/**
 * The trip as it will be: his length and times once he typed any, else the trip's own length
 * (`set`) or the placeholder (`unset`). Null until the trip's length is read, or when what he
 * typed makes no trip.
 */
export function panelPreview(
  state: TravelPanelState,
  answer: TravelPreviewResponse | undefined,
): PanelPreview | null {
  const span = panelSpan(state);
  if (span === null) {
    return null;
  }
  if (typedLength(state) !== null || state.start !== null || state.end !== null) {
    return { ...span, source: 'set' };
  }
  if ((answer?.source ?? null) === null) {
    return null;
  }
  return { ...span, source: lengthUnset(state) ? 'unset' : 'set' };
}

/** "13:20" kept left to right inside a Hebrew line. */
const ltr = (text: string): string => `⁦${text}⁩`;

/** "Leave 13:20 · arrive 13:52 · 32 min (set by you)". */
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
    source: t(`travel.leg.sources.${preview.source}`),
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
 * cancelled, and never a travel leg. A painted area takes travel too ("Studying" at Braude): the
 * items inside it with a place of their own get theirs, the rest of it is spent at its place.
 */
export function canTravelTo(item: {
  kind: string;
  startAt: Date | string | null;
  allDay: boolean;
  status: string;
}): boolean {
  return (
    item.startAt !== null && !item.allDay && item.status !== 'cancelled' && item.kind !== 'travel'
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

// ─── A leg's own sheet ──────────────────────────────────────────────────────

/**
 * A leg's sheet as it opens: its own times (held at its arrival, or its departure for a trip
 * back), its own length, and how long its trip takes every time (`tripMinutes`: null while the
 * trip has none). Nothing typed yet.
 */
export function legPanelState(
  item: { startAt: Date | string | null; endAt: Date | string | null },
  travel: TravelLegProps,
  tripMinutes: number | null,
): TravelPanelState {
  const start = toDate(item.startAt);
  const end = toDate(item.endAt);
  const departs = travel.direction === 'back';
  return {
    ...initialPanelState({
      mode: travel.mode,
      fromPlaceId: travel.fromPlaceId,
      toPlaceId: travel.toPlaceId,
      anchorStart: departs ? start : end,
    }),
    minutes: tripMinutes,
    ownMinutes:
      start !== null && end !== null
        ? (end.getTime() - start.getTime()) / MINUTE_MS
        : travel.minutes,
    // A leg back leaves as its event ends: a length alone keeps that, as the server does.
    ...(departs ? { keepsDeparture: true } : {}),
  };
}

/**
 * How long a leg's trip takes, every time, as its sheet knows it: the leg's own length while it
 * follows the trip (not set yet: null); for a leg he timed by hand, the trip's own (`tripAnswer`,
 * the preview's; undefined while it is read), since his times are this leg's only.
 */
export function legTripMinutes(
  travel: TravelLegProps,
  tripAnswer: TravelPreviewResponse | undefined,
): number | null | undefined {
  if (!travel.edited) {
    return travel.lengthUnset ? null : travel.minutes;
  }
  if (tripAnswer === undefined) {
    return undefined;
  }
  return tripAnswer.lengthUnset ? null : tripAnswer.minutes;
}

/**
 * `PATCH …/travel/legs/:id`: the length he typed (the trip's, every time) and the times he typed
 * (this leg's only), as the form shows them, so the server's answer is what he saw. Null while he
 * has typed nothing, or what he typed makes no trip.
 */
export function legEditOf(state: TravelPanelState): LegEditRequest | null {
  const minutes = typedLength(state);
  if ((minutes === null && state.start === null && state.end === null) || !panelSpan(state)) {
    return null;
  }
  return {
    ...(state.start === null ? {} : { startAt: state.start.toISOString() }),
    ...(state.end === null ? {} : { endAt: state.end.toISOString() }),
    ...(minutes === null ? {} : { minutes }),
  };
}
