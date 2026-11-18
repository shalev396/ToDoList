/**
 * A member's place (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Concepts", 1, as the
 * owner's decision of 2026-11-18 amends it): a name, aliases ("ORT Braude", "בראודה"), and an
 * address if he wants one. The address is free text, never looked up: it is used only to open a
 * map app on his device (TravelLeg#links); a typed "lat, lon" is text like any other. Places are
 * their member's only: every read and write is scoped to the caller as owner (another member's
 * place is a 404, as one that never existed), only the owner's REST answers carry the address
 * (`toView`), and an agent gets names only (`toAgentView`). Places are not audited (plan Ruling
 * 15), so an address is never in an audit row, and never logged.
 *
 * - At most one place is Home, the start and end of every day: making one Home makes the old one a
 *   plain place (and a unique index holds it).
 * - A member keeps at most PLAN_LIMITS.placesPerMember places (409 `travel_limit`).
 * - Changes are for editors and owners (Ruling 16).
 */
import { AppError } from '../../errors/AppError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { PlaceData, PlacePatch } from '../../models/definitions/Place.js';
import { getPlaceRepository } from '../../models/index.js';
import { PLAN_LIMITS } from '../../types/limits.js';
import type { PlaceAgentView, PlaceView } from '../../types/travel.js';
import type { Caller } from '../base/Caller.js';
import type { Owned, Viewable } from '../base/contracts.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { TravelData } from './TravelData.js';

/** A new place as callers give it: a name, and an address if he wants one. */
export interface NewPlace {
  name: string;
  /** Free text, for map links only (never looked up). */
  address?: string | undefined;
  aliases?: string[] | undefined;
  home?: boolean | undefined;
}

/** A change to a place: any of it; what is left out stays as it is. */
export type PlaceChange = { [K in keyof NewPlace]?: NewPlace[K] | undefined };

const NAME_MAX = 80;
const ADDRESS_MAX = 300;
const ALIASES_MAX = 10;

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** A name or an alias: trimmed, 1–80 characters. */
function label(text: string, field: string): string {
  const trimmed = text.trim();
  if (trimmed === '') throw new ValidationError(`${field}: Must not be empty`);
  if (trimmed.length > NAME_MAX) {
    throw new ValidationError(`${field}: at most ${String(NAME_MAX)} characters`);
  }
  return trimmed;
}

/** Each alias once (whatever its case), none that is the name itself; at most 10. */
function aliasesOf(aliases: readonly string[], name: string): string[] {
  const seen = new Set([name.toLocaleLowerCase()]);
  const kept: string[] = [];
  for (const alias of aliases) {
    const text = label(alias, 'aliases');
    const key = text.toLocaleLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    kept.push(text);
  }
  if (kept.length > ALIASES_MAX) {
    throw new ValidationError(`aliases: at most ${String(ALIASES_MAX)}`);
  }
  return kept;
}

/** The address as kept: trimmed, at most 300 characters; empty is none. */
function addressOf(address: string): string | null {
  const trimmed = address.trim();
  if (trimmed.length > ADDRESS_MAX) {
    throw new ValidationError(`address: at most ${String(ADDRESS_MAX)} characters`);
  }
  return trimmed === '' ? null : trimmed;
}

export class Place extends WorkspaceEntity<PlaceData> implements Owned, Viewable<PlaceView> {
  private constructor(data: PlaceData) {
    super(data);
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /** The caller's places, oldest first. */
  static async listOwn(caller: Caller): Promise<Place[]> {
    const rows = await (await getPlaceRepository()).listOwn(caller.workspaceId, caller.userId);
    return rows.map((row) => new Place(row));
  }

  /** The caller's place with this id; 404 for anyone else's, or none. */
  static async findOwn(caller: Caller, id: string): Promise<Place> {
    const row = await (await getPlaceRepository()).findOwn(caller.workspaceId, caller.userId, id);
    if (row === null) throw new NotFoundError();
    return new Place(row);
  }

  /** 400 unless `placeId` is one of the caller's places (a rule's place, a pin). */
  static async assertOwn(caller: Caller, placeId: string): Promise<void> {
    const row = await (
      await getPlaceRepository()
    ).findOwn(caller.workspaceId, caller.userId, placeId);
    if (row === null) throw new ValidationError('placeId: not one of your places');
  }

  /**
   * The caller's place that goes by this name (its name or an alias, whatever the case): how an
   * agent names a place. 400 when none does (the message lists nothing of theirs).
   */
  static async findNamed(caller: Caller, name: string): Promise<Place> {
    const wanted = name.trim().toLocaleLowerCase();
    const found = (await Place.listOwn(caller)).find((place) =>
      [place.name, ...place.aliases].some((known) => known.toLocaleLowerCase() === wanted),
    );
    if (found === undefined) throw new ValidationError('place: not the name of one of your places');
    return found;
  }

  /** The caller's Home; null when they have none (no Home, no legs). */
  static async homeOf(caller: Caller): Promise<Place | null> {
    return (await Place.listOwn(caller)).find((place) => place.isHome) ?? null;
  }

  get ownerUserId(): string {
    return this.data.ownerUserId;
  }

  isOwnedBy(userId: string): boolean {
    return this.data.ownerUserId === userId;
  }

  get name(): string {
    return this.data.name;
  }

  get aliases(): readonly string[] {
    return this.data.aliases;
  }

  get address(): string | null {
    return this.data.address;
  }

  get isHome(): boolean {
    return this.data.home;
  }

  /** As its member's own REST answers show it: with its address. */
  toView(): PlaceView {
    return {
      id: this.id,
      name: this.data.name,
      aliases: [...this.data.aliases],
      home: this.data.home,
      address: this.data.address,
    };
  }

  /** As an agent sees it: its name only. */
  toAgentView(): PlaceAgentView {
    return {
      id: this.id,
      name: this.data.name,
      aliases: [...this.data.aliases],
      home: this.data.home,
    };
  }

  // ─── Changes ──────────────────────────────────────────────────────────────

  /**
   * Editors: a new place of the caller's, by name (an address is optional, and never looked up).
   * A new Home makes the old one a plain place. 409 `travel_limit` at the cap.
   */
  static async create(caller: Caller, input: NewPlace): Promise<Place> {
    caller.require('editor');
    const name = label(input.name, 'name');
    const aliases = aliasesOf(input.aliases ?? [], name);
    const address = input.address === undefined ? null : addressOf(input.address);
    const places = await getPlaceRepository();
    if ((await places.countOwn(caller.workspaceId, caller.userId)) >= PLAN_LIMITS.placesPerMember) {
      throw new AppError(409, 'You have the most places allowed: remove one first', {
        code: 'travel_limit',
      });
    }
    const home = input.home === true;
    return Place.#asHome(home, async () => {
      if (home) await places.clearHome(caller.workspaceId, caller.userId);
      return places.create(caller.workspaceId, {
        ownerUserId: caller.userId,
        name,
        aliases,
        address,
        home,
      });
    });
  }

  /** Editors, on their own place: a new name, aliases, address (empty clears it) or Home. */
  async update(caller: Caller, patch: PlaceChange): Promise<Place> {
    this.#authorize(caller);
    const change: PlacePatch = {};
    const name = patch.name === undefined ? this.name : label(patch.name, 'name');
    if (patch.name !== undefined) change.name = name;
    if (patch.aliases !== undefined || patch.name !== undefined) {
      change.aliases = aliasesOf(patch.aliases ?? this.aliases, name);
    }
    if (patch.address !== undefined) change.address = addressOf(patch.address);
    if (patch.home !== undefined) change.home = patch.home;
    const places = await getPlaceRepository();
    return Place.#asHome(change.home === true, async () => {
      if (change.home === true) {
        await places.clearHome(this.workspaceId, this.ownerUserId, this.id);
      }
      return places.update(this.workspaceId, this.ownerUserId, this.id, change);
    });
  }

  /**
   * Editors, on their own place: it goes, and so does everything of theirs that points at it (a
   * rule's place, a pin, the lengths set for trips from or to it). Removing Home leaves no Home:
   * the next regeneration makes no legs until there is one.
   */
  async remove(caller: Caller): Promise<void> {
    this.#authorize(caller);
    const deleted = await (
      await getPlaceRepository()
    ).delete(this.workspaceId, this.ownerUserId, this.id);
    if (!deleted) throw new NotFoundError();
    await TravelData.forgetPlace(this.workspaceId, this.ownerUserId, this.id);
  }

  // ─── Inside ───────────────────────────────────────────────────────────────

  /** 404 unless it is the caller's own place (here); then the editor check (403). */
  #authorize(caller: Caller): void {
    this.assertIn(caller);
    if (!this.isOwnedBy(caller.userId)) throw new NotFoundError();
    caller.require('editor');
  }

  /**
   * Runs a write that may make a place Home. Two Homes made at once meet the unique index: the
   * loser clears the winner's Home and writes again, once (the last Home made wins).
   */
  static async #asHome(home: boolean, write: () => Promise<PlaceData | null>): Promise<Place> {
    for (let attempt = 0; ; attempt += 1) {
      try {
        const row = await write();
        if (row === null) throw new NotFoundError();
        return new Place(row);
      } catch (error) {
        if (!home || attempt > 0 || !isDuplicateKey(error)) throw error;
      }
    }
  }
}
