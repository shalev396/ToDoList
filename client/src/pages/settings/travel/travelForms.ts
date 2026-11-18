/**
 * Settings → Travel's forms, pure (docs/superpowers/specs/2026-11-17-travel-time-design.md):
 * a place as typed (an address, or coordinates typed as "lat, lon"), the settings' number fields
 * with the server's bounds, a rule's "When …" sentence as its where-scope, and the next 14 days.
 */
import type { Query, RuleGroup } from '@api-types/builder.ts';
import {
  TRAVEL_HORIZON_DAYS,
  type CreatePlaceRequest,
  type PlaceView,
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

/** The server's own pattern (Geocoder.parseCoordinates): "lat, lon" in decimal degrees. */
const COORDINATES = /^\s*(-?\d{1,3}(?:\.\d+)?)\s*,\s*(-?\d{1,3}(?:\.\d+)?)\s*$/;

/** Coordinates typed as "lat, lon" (latitude −90 to 90, longitude −180 to 180), or null. */
export function parseCoordinates(text: string): { lat: number; lon: number } | null {
  const match = COORDINATES.exec(text);
  if (match === null) {
    return null;
  }
  const lat = Number(match[1]);
  const lon = Number(match[2]);
  if (Math.abs(lat) > 90 || Math.abs(lon) > 180) {
    return null;
  }
  return { lat, lon };
}

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

export type PlaceForm =
  | { ok: true; request: CreatePlaceRequest }
  | { ok: false; problem: 'name' | 'address' };

/**
 * The request for a place as typed. Typed coordinates go as `coords` (no lookup), the text kept
 * as its address so its owner sees what they typed; any other address is looked up by the server.
 * A new place needs an address or coordinates; an `editing` one may have its address cleared (its
 * coordinates stay).
 */
export function placeRequestOf(draft: PlaceDraft, editing = false): PlaceForm {
  const name = draft.name.trim();
  const address = draft.address.trim();
  if (name === '') {
    return { ok: false, problem: 'name' };
  }
  if (address === '' && !editing) {
    return { ok: false, problem: 'address' };
  }
  const request: CreatePlaceRequest = { name };
  if (address !== '') {
    request.address = address;
    const coords = parseCoordinates(address);
    if (coords !== null) {
      request.coords = coords;
    }
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

/**
 * What changed in a saved place, as its PATCH: only the parts that differ, so an address that
 * stayed the same is not looked up again. Null when nothing changed.
 */
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
    if (request.coords !== undefined) {
      patch.coords = request.coords;
    }
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
  factor: { min: 0.5, max: 3 },
  buffer: { min: 0, max: 120 },
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

/** A factor as typed, clamped to 0.5–3 and rounded to hundredths; `fallback` when not a number. */
export function factorFromInput(text: string, fallback: number): number {
  const value = typedNumber(text);
  if (value === null) {
    return fallback;
  }
  return Math.round(clamp(value, TRAVEL_BOUNDS.factor) * 100) / 100;
}

/** A buffer as typed, in whole minutes, 0–120; `fallback` when not a number. */
export function bufferFromInput(text: string, fallback: number): number {
  const value = typedNumber(text);
  return value === null ? fallback : clamp(Math.round(value), TRAVEL_BOUNDS.buffer);
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
    factors: { ...settings.factors },
    buffers: { ...settings.buffers },
    goHome: { ...settings.goHome },
    defaultMode: settings.defaultMode,
  };
}

export function sameSettings(a: Readonly<TravelSettings>, b: Readonly<TravelSettings>): boolean {
  const modes = ['walk', 'drive', 'transit'] as const;
  return (
    modes.every((mode) => a.factors[mode] === b.factors[mode]) &&
    modes.every((mode) => a.buffers[mode] === b.buffers[mode]) &&
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
