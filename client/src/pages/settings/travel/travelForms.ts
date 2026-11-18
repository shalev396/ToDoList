/**
 * Settings → Travel's forms, pure (docs/superpowers/specs/2026-11-17-travel-time-design.md):
 * a place as typed (a name, and an address that only opens a map app), the go-home fields with the
 * server's bounds, a rule's "When …" sentence as its where-scope, and the next 14 days.
 */
import type { Query, RuleGroup } from '@api-types/builder.ts';
import {
  TRAVEL_HORIZON_DAYS,
  type CreatePlaceRequest,
  type CreateTravelRuleRequest,
  type PlaceView,
  type RuleDirection,
  type TravelMode,
  type TravelRuleScope,
  type TravelSettings,
  type UpdatePlaceRequest,
} from '@api-types/travel.ts';

// ─── Places ─────────────────────────────────────────────────────────────────

/** A place as the form holds it: aliases are one text, split on commas and lines. */
export interface PlaceDraft {
  name: string;
  address: string;
  aliases: string;
  home: boolean;
}

export const EMPTY_PLACE: PlaceDraft = { name: '', address: '', aliases: '', home: false };

/** Aliases split on commas and lines, trimmed, each once whatever its case. */
export function parseAliases(text: string): string[] {
  const seen = new Set<string>();
  const aliases: string[] = [];
  for (const part of text.split(/[\n,]/)) {
    const alias = part.trim();
    const key = alias.toLocaleLowerCase();
    if (alias === '' || seen.has(key)) {
      continue;
    }
    seen.add(key);
    aliases.push(alias);
  }
  return aliases;
}

export type PlaceForm = { ok: true; request: CreatePlaceRequest } | { ok: false; problem: 'name' };

/**
 * The request for a place as typed: a name, and an address if he typed one (free text, never
 * looked up; it only opens a map app).
 */
export function placeRequestOf(draft: PlaceDraft): PlaceForm {
  const name = draft.name.trim();
  const address = draft.address.trim();
  if (name === '') {
    return { ok: false, problem: 'name' };
  }
  const request: CreatePlaceRequest = { name };
  if (address !== '') {
    request.address = address;
  }
  request.aliases = parseAliases(draft.aliases);
  request.home = draft.home;
  return { ok: true, request };
}

/** The form for a saved place: its name, address, aliases and Home as they are. */
export function placeDraftOf(place: PlaceView): PlaceDraft {
  return {
    name: place.name,
    address: place.address ?? '',
    aliases: place.aliases.join(', '),
    home: place.home,
  };
}

/** What changed in a saved place, as its PATCH: only the parts that differ. Null when nothing did. */
export function placePatchOf(
  place: PlaceView,
  request: CreatePlaceRequest,
): UpdatePlaceRequest | null {
  const patch: UpdatePlaceRequest = {};
  if (request.name !== place.name) {
    patch.name = request.name;
  }
  if ((request.address ?? '') !== (place.address ?? '')) {
    patch.address = request.address ?? '';
  }
  const aliases = request.aliases ?? [];
  if (aliases.join('\n') !== place.aliases.join('\n')) {
    patch.aliases = aliases;
  }
  if ((request.home ?? false) !== place.home) {
    patch.home = request.home ?? false;
  }
  return Object.keys(patch).length === 0 ? null : patch;
}

// ─── Settings ───────────────────────────────────────────────────────────────

/** The server's bounds (TravelSettingsSchema). */
export const TRAVEL_BOUNDS = {
  minWindowMinutes: { min: 180, max: 24 * 60 },
  minAtHomeMinutes: { min: 60, max: 24 * 60 },
} as const;

/** A number as typed: a comma is a decimal point; anything else that isn't a number is null. */
function typedNumber(text: string): number | null {
  const trimmed = text.trim().replace(',', '.');
  if (trimmed === '') {
    return null;
  }
  const value = Number(trimmed);
  return Number.isFinite(value) ? value : null;
}

function clamp(value: number, bounds: { min: number; max: number }): number {
  return Math.min(bounds.max, Math.max(bounds.min, value));
}

/** Go-home minutes as typed: a window of at least 3 hours, at least an hour at home. */
export function goHomeFromInput(
  text: string,
  field: 'minWindowMinutes' | 'minAtHomeMinutes',
  fallback: number,
): number {
  const value = typedNumber(text);
  return value === null ? fallback : clamp(Math.round(value), TRAVEL_BOUNDS[field]);
}

/** A copy of the settings to edit (the saved ones are never changed in place). */
export function settingsDraftOf(settings: Readonly<TravelSettings>): TravelSettings {
  return {
    goHome: { ...settings.goHome },
    defaultMode: settings.defaultMode,
  };
}

export function sameSettings(a: Readonly<TravelSettings>, b: Readonly<TravelSettings>): boolean {
  return (
    a.goHome.enabled === b.goHome.enabled &&
    a.goHome.minWindowMinutes === b.goHome.minWindowMinutes &&
    a.goHome.minAtHomeMinutes === b.goHome.minAtHomeMinutes &&
    a.defaultMode === b.defaultMode
  );
}

// ─── Rules ──────────────────────────────────────────────────────────────────

/**
 * The scope a rule's "When …" sentence makes: its where-group. Only the conditions count (the
 * sentence's sort means nothing to travel). Null without a condition, since a rule that matches
 * everything would add travel he never asked for.
 */
export function ruleScopeOf(query: Query): TravelRuleScope | null {
  const where = query.where;
  if (where === undefined || where.rules.length === 0) {
    return null;
  }
  const copy: RuleGroup = { combinator: where.combinator, rules: where.rules };
  if (where.not === true) {
    copy.not = true;
  }
  return { kind: 'where', where: copy };
}

/** The sentence's query for a rule: its where-group, or none for a rule on one item or series. */
export function queryOfScope(scope: TravelRuleScope): Query {
  return scope.kind === 'where' ? { source: 'items', where: scope.where } : { source: 'items' };
}

/**
 * The "New rule" form: its sentence, trips and place, and the mode he picked (null: none yet, so
 * it follows the default mode, which may change in Times while the form is open).
 */
export interface NewRuleDraft {
  query: Query;
  mode: TravelMode | null;
  direction: RuleDirection;
  placeId: string | null;
}

export const NEW_RULE: Readonly<NewRuleDraft> = Object.freeze<NewRuleDraft>({
  query: { source: 'items' },
  mode: null,
  direction: 'both',
  placeId: null,
});

/** The new rule's request, on his mode or else today's default; null without a condition. */
export function newRuleRequestOf(
  draft: Readonly<NewRuleDraft>,
  defaultMode: TravelMode,
): CreateTravelRuleRequest | null {
  const scope = ruleScopeOf(draft.query);
  if (scope === null) {
    return null;
  }
  return {
    scope,
    mode: draft.mode ?? defaultMode,
    direction: draft.direction,
    placeId: draft.placeId,
  };
}

// ─── Focus ──────────────────────────────────────────────────────────────────

/**
 * Where focus goes once a place is removed: the next place, else the one before it; null when
 * none is left (focus goes to the form that adds one).
 */
export function neighbourAfterRemoval(ids: readonly string[], removedId: string): string | null {
  const at = ids.indexOf(removedId);
  if (at === -1) {
    return null;
  }
  return ids[at + 1] ?? ids[at - 1] ?? null;
}

// ─── The next 14 days ───────────────────────────────────────────────────────

/** `YYYY-MM-DD` moved by whole calendar days. */
export function addDays(day: string, days: number): string {
  const [year = 1970, month = 1, date = 1] = day.split('-').map(Number);
  return new Date(Date.UTC(year, month - 1, date + days)).toISOString().slice(0, 10);
}

/** Today and the 13 days after it: the days legs exist for. */
export function horizonOf(today: string): { from: string; to: string } {
  return { from: today, to: addDays(today, TRAVEL_HORIZON_DAYS - 1) };
}

/** The current page's search with `travelDay` set to the day (its other parameters kept). */
export function dayLink(search: string, day: string): string {
  const params = new URLSearchParams(search);
  params.set('travelDay', day);
  return `?${params.toString()}`;
}
