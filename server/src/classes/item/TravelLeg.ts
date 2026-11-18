/**
 * A travel leg (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Object model"): the time
 * TodoList adds to get its member to, from or between the places their day happens in. A local
 * item of kind `travel`, a sibling of TimeBlock under ScheduledItem: never Completable and never
 * Deletable (it is skipped instead: 409 `not_deletable`).
 *
 * A leg is private to its member: stored `visibility: 'private'` and owned by them, and ItemPolicy
 * reads a leg for its owner only, whatever its visibility says (Ruling 8). It takes its topic and
 * subject from the event it serves, so neither is set on the leg itself. What makes it a leg is at
 * `props.travel` (types/travel.ts), and its key (LegKey) at `props.travelKey`: one leg per key.
 *
 * Storage (travel storage, plan Task 11):
 * - `applyPlan` writes what LegReconciler worked out, by key, and only the caller's own legs: a
 *   plan applied twice writes nothing the second time. Each write is conditional on the leg as it
 *   is read then, so a skip, a hand edit or a start made while the plan was worked out is never
 *   overwritten (that leg waits for the next regeneration).
 * - A leg the member edited keeps his times and the anchor start his edit was made against, unless
 *   the plan changes its mode or a place (it is recomputed then). When its anchor moves, it is
 *   flagged ("the event moved") with where the anchor is now; his next edit acknowledges the move
 *   and clears the flag, and Reset clears it with his times.
 * - A removed leg is a tombstone: soft-deleted, with its reason at `props.travel.removedReason`, so
 *   the day panel can say why it went (the purge keeps it at least until the leg is over). A skip
 *   is a tombstone with reason `skipped`, which no regeneration brings back; Reset does.
 * - The member's own changes: new times (any two of start, end and length, the third worked out),
 *   a skip, a reset. Each is the owner's only (404 for anyone else) and an editor's (403).
 *
 * Stored props that aren't a leg's read as none (`travel` is null): reads never throw on them.
 */
import type { Caller } from '../base/Caller.js';
import { DayPlanner, type PlannedLeg } from '../travel/DayPlanner.js';
import type { Reconciliation, StoredLegFacts } from '../travel/LegReconciler.js';
import { Place } from '../travel/Place.js';
import { TravelProfile } from '../travel/TravelProfile.js';
import { AppError } from '../../errors/AppError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type {
  ItemData,
  ScheduledItemPatch,
  TravelLegWrite,
} from '../../models/definitions/Item.js';
import { getItemRepository } from '../../models/index.js';
import { SUBJECT_ATTRIBUTE_KEY } from '../../types/attributes.js';
import { solveSpan, type Span, type SpanField } from '../../types/timeSpan.js';
import { travelPropsOf, type RemovalReason, type TravelLegProps } from '../../types/travel.js';
import { Item } from './Item.js';
import type { ItemEdit } from './ItemEdit.js';
import type { OverlayEdit } from './Overlay.js';
import { ScheduledItem } from './ScheduledItem.js';

const FROM_ITS_EVENT = 'travel takes it from its event';

/** New times for a leg: any two of start, end and length (minutes); one keeps the rest. */
export interface LegTimesChange {
  startAt?: Date | undefined;
  endAt?: Date | undefined;
  minutes?: number | undefined;
}

/** What one apply of a plan did. */
export interface AppliedPlan {
  created: number;
  updated: number;
  removed: number;
}

/** The longest leg: a day. */
const MAX_MINUTES = 24 * 60;
const MINUTE_MS = 60_000;
/** How often a change made on a stale read is read again and retried before a 409. */
const SAVE_ATTEMPTS = 5;

/** The change's fields as the span solver names them, in the order the solver keeps them. */
const SPAN_FIELDS = { startAt: 'start', endAt: 'end', minutes: 'minutes' } as const;

/** The caller's places as a leg names them: by id, and which is Home. */
interface PlaceNames {
  names: ReadonlyMap<string, string>;
  homeId: string | null;
}

export class TravelLeg extends ScheduledItem {
  static {
    Item.register('travel', (data) => new TravelLeg(data));
  }

  private constructor(data: ItemData) {
    super(data);
  }

  /** A leg is no time block: it has no layer. */
  readonly layer = null;

  // ─── What it is ───────────────────────────────────────────────────────────

  /**
   * What makes it a leg: its anchor, direction, places by name, mode, length and source. Null when
   * its stored props are not a leg's (a list shows it as it is; nothing here throws).
   */
  get travel(): TravelLegProps | null {
    return travelPropsOf(this.data.props);
  }

  /** Its key (`owner|anchor|occurrence|direction`); null when none is stored. */
  get key(): string | null {
    const key = this.data.props['travelKey'];
    return typeof key === 'string' ? key : null;
  }

  /** Why it went: null while it is live; a tombstone's reason (`cancelled` when none is stored). */
  get removedReason(): RemovalReason | null {
    if (this.data.deletedAt === null) return null;
    return this.travel?.removedReason ?? 'cancelled';
  }

  // ─── Storage ──────────────────────────────────────────────────────────────

  /**
   * Writes a reconciliation of the caller's legs (LegReconciler.reconcile): removes the live legs
   * it names as tombstones, updates (or brings back) the stored ones, creates the new ones, all by
   * key. Only the caller's own legs: a leg planned for anyone else throws, and an id that is not
   * one of the caller's legs is passed over. A write that changes nothing is not counted.
   */
  static async applyPlan(caller: Caller, recon: Reconciliation, now: Date): Promise<AppliedPlan> {
    const owner = caller.userId;
    for (const leg of [...recon.create, ...recon.update.map((change) => change.leg)]) {
      if (leg.key.ownerUserId !== owner) {
        throw new Error("TravelLeg.applyPlan: a plan holds only the caller's own legs");
      }
    }
    const items = await getItemRepository();
    const ids = [...recon.update.map(({ id }) => id), ...recon.remove.map(({ id }) => id)];
    const rows =
      ids.length === 0
        ? []
        : await items.listTravelLegs(caller.workspaceId, {
            ownerUserId: owner,
            ids,
            includeRemoved: true,
          });
    const stored = new Map(rows.map((row) => [row.id, row]));
    const places = await TravelLeg.#placeNames(caller);
    const applied: AppliedPlan = { created: 0, updated: 0, removed: 0 };

    for (const { id, reason } of recon.remove) {
      const row = stored.get(id);
      // Not the caller's, removed meanwhile, or under way since: left as it is.
      if (row?.deletedAt !== null || TravelLeg.#startedBy(row, now)) continue;
      if ((await items.removeTravelLeg(caller.workspaceId, id, reason, now)) !== null) {
        applied.removed += 1;
      }
    }
    for (const change of recon.update) {
      const row = stored.get(change.id);
      // Not one of the caller's legs: passed over.
      if (row === undefined) continue;
      const key = change.leg.key.toString();
      if (row.props['travelKey'] !== key) continue;
      const edited = travelPropsOf(row.props)?.edited === true;
      if (!TravelLeg.#stillAsPlanned(row, change, edited, now)) continue;
      const write = TravelLeg.#write(owner, change.leg, places, now, {
        row,
        // He reset it since: it is recomputed.
        keepTimes: change.keepTimes && edited,
        anchorMoved: change.anchorMoved,
      });
      // Written only while the leg is still as read (and so as judged above), atomically.
      const { outcome } = await items.upsertTravelLeg(caller.workspaceId, key, write, {
        unchangedSince: row.updatedAt,
        edited,
        notSkipped: true,
        notStartedBefore: now,
      });
      if (outcome === 'updated' || outcome === 'created') applied.updated += 1;
    }
    for (const leg of recon.create) {
      const write = TravelLeg.#write(owner, leg, places, now, null);
      // A leg stored under its key that the facts missed: never a skip brought back, a hand edit
      // overwritten or a leg under way moved.
      const { outcome } = await items.upsertTravelLeg(
        caller.workspaceId,
        leg.key.toString(),
        write,
        {
          edited: false,
          notSkipped: true,
          notStartedBefore: now,
        },
      );
      if (outcome === 'created') applied.created += 1;
      else if (outcome === 'updated') applied.updated += 1;
    }
    return applied;
  }

  /**
   * The caller's legs that start in [from, to), live and tombstones, as the reconciler reads them.
   * A leg whose stored props are not a leg's is left out (a planned leg with its key repairs it).
   */
  static async storedFacts(caller: Caller, from: Date, to: Date): Promise<StoredLegFacts[]> {
    return (await TravelLeg.#listOwn(caller, { from, to })).flatMap((leg) => {
      const facts = leg.#facts();
      return facts === null ? [] : [facts];
    });
  }

  /** The caller's legs that start in [from, to), by start: the live ones and the tombstones. */
  static async listDays(
    caller: Caller,
    from: Date,
    to: Date,
  ): Promise<{ live: TravelLeg[]; removed: TravelLeg[] }> {
    const legs = await TravelLeg.#listOwn(caller, { from, to });
    return {
      live: legs.filter((leg) => !leg.isDeleted),
      removed: legs.filter((leg) => leg.isDeleted),
    };
  }

  /** The caller's own leg with this id, a tombstone too (to reset a skip); 404 otherwise. */
  static async findOwn(caller: Caller, id: string): Promise<TravelLeg> {
    const [leg] = await TravelLeg.#listOwn(caller, { ids: [id] });
    if (leg === undefined) throw new NotFoundError();
    return leg;
  }

  // ─── The member's changes ─────────────────────────────────────────────────

  /**
   * New times, by hand: any two of start, end and length (`solveSpan`), the third worked out. One
   * alone keeps the length (a new start or end), or the arrival (a new length of a leg there or
   * between; a leg back keeps its departure). The leg is then the member's (`edited`, source
   * `manual`): a regeneration keeps his times until he resets it, and the length is remembered for
   * the same trip. A leg flagged "the event moved" is edited against the anchor's new start, so the
   * flag clears. 400 for anything that isn't a span of more than 0 and at most a day.
   */
  async editTimes(caller: Caller, change: LegTimesChange): Promise<TravelLeg> {
    this.#authorize(caller);
    if (this.isDeleted) {
      throw new AppError(409, 'This travel was skipped or removed: reset it before editing it');
    }
    const given = (Object.keys(SPAN_FIELDS) as (keyof LegTimesChange)[]).filter(
      (field) => change[field] !== undefined,
    );
    if (given.length === 0 || given.length === 3) {
      throw new ValidationError('startAt: give one or two of startAt, endAt and minutes');
    }
    const saved = await this.#save((current) => {
      const travel = current.travel;
      if (travel === null) throw new ValidationError('travel: this leg has no travel to edit');
      const span = current.#spanAfter(change, given, travel);
      return {
        startAt: span.start,
        endAt: span.end,
        props: {
          ...current.data.props,
          travel: {
            ...travel,
            minutes: span.minutes,
            source: 'manual',
            computedAt: new Date().toISOString(),
            edited: true,
            // An edit after the event moved is made against its new start: it acknowledges it.
            ...(travel.anchorStartNow === null
              ? {}
              : { anchorStart: travel.anchorStartNow, anchorMoved: false, anchorStartNow: null }),
          },
        },
      };
    });
    const travel = saved.travel;
    if (travel !== null && travel.fromPlaceId !== '' && travel.toPlaceId !== '') {
      const trip = DayPlanner.tripKey(travel.fromPlaceId, travel.toPlaceId, travel.mode);
      await (await TravelProfile.of(caller)).remember(caller, trip, travel.minutes);
    }
    return saved;
  }

  /**
   * Skipped for its day: a tombstone with reason `skipped`, which no regeneration brings back
   * (Reset does). A leg already removed stays as it is.
   */
  async skip(caller: Caller): Promise<TravelLeg> {
    this.#authorize(caller);
    if (this.isDeleted) return this;
    const row = await (
      await getItemRepository()
    ).removeTravelLeg(this.workspaceId, this.id, 'skipped');
    // Removed meanwhile (a regeneration): the leg as it is now.
    if (row === null) return TravelLeg.findOwn(caller, this.id);
    return TravelLeg.#of(Item.from(row));
  }

  /**
   * Back to computed: his edit and the "event moved" flag are cleared, and a skipped leg is live
   * again; the next regeneration recomputes its times. A leg removed for its event's sake (not
   * skipped) comes back only with its event, so a reset leaves it as it is.
   */
  async reset(caller: Caller): Promise<TravelLeg> {
    this.#authorize(caller);
    const travel = this.travel;
    if (travel === null) return this;
    if (this.isDeleted) {
      return this.removedReason === 'skipped' ? this.#restore(travel) : this;
    }
    if (!travel.edited && !travel.anchorMoved) return this;
    return this.#save((current) => {
      const now = current.travel;
      if (now === null) throw new ValidationError('travel: this leg has no travel to reset');
      return {
        props: {
          ...current.data.props,
          travel: { ...now, edited: false, anchorMoved: false, anchorStartNow: null },
        },
      };
    });
  }

  /**
   * A generic edit (`PATCH …/items/:id`, plan Ruling 7): a hand edit of its start and end
   * (`editTimes`); any other field is 400, and so is clearing either.
   */
  async edit(caller: Caller, edit: ItemEdit): Promise<TravelLeg> {
    const refused = edit.fields.find((field) => field !== 'startAt' && field !== 'endAt');
    if (refused !== undefined) {
      throw new ValidationError(
        `${refused}: travel takes a new start and end (PATCH /travel/legs/:id for its length)`,
      );
    }
    const startAt = edit.get('startAt');
    const endAt = edit.get('endAt');
    if (startAt === null || endAt === null) {
      throw new ValidationError('startAt: travel keeps its start and end');
    }
    return this.editTimes(caller, { startAt, endAt });
  }

  /** TodoList's own fields, but never a topic or a subject of its own (400): its event's apply. */
  override setOverlay(caller: Caller, edit: OverlayEdit): Promise<Item> {
    if (edit.topicOverride !== undefined) {
      return Promise.reject(new ValidationError(`topicOverride: ${FROM_ITS_EVENT}`));
    }
    if (edit.attrs !== undefined && Object.hasOwn(edit.attrs, SUBJECT_ATTRIBUTE_KEY)) {
      return Promise.reject(new ValidationError(`${SUBJECT_ATTRIBUTE_KEY}: ${FROM_ITS_EVENT}`));
    }
    return super.setOverlay(caller, edit);
  }

  /** Custom attribute values, but never a subject of its own (400): its event's applies. */
  override setAttributes(
    caller: Caller,
    values: Readonly<Record<string, unknown>>,
    now: Date = new Date(),
  ): Promise<Item> {
    if (Object.hasOwn(values, SUBJECT_ATTRIBUTE_KEY)) {
      return Promise.reject(new ValidationError(`${SUBJECT_ATTRIBUTE_KEY}: ${FROM_ITS_EVENT}`));
    }
    return super.setAttributes(caller, values, now);
  }

  // ─── Inside ───────────────────────────────────────────────────────────────

  /** 404 unless it is the caller's own leg (here); then the editor check (403). */
  #authorize(caller: Caller): void {
    this.assertIn(caller);
    if (this.ownerUserId !== caller.userId) throw new NotFoundError();
    caller.require('editor');
  }

  /**
   * Whether an update the reconciler worked out from earlier facts still fits the leg as read now:
   * not when it was removed or skipped since (and the update isn't a restore), when he edited it
   * since (and the update would recompute it), or when it got under way since.
   */
  static #stillAsPlanned(
    row: ItemData,
    change: Reconciliation['update'][number],
    edited: boolean,
    now: Date,
  ): boolean {
    const live = row.deletedAt === null;
    if (!live && !change.restore) return false;
    if (!live && travelPropsOf(row.props)?.removedReason === 'skipped') return false;
    if (edited && !change.keepTimes) return false;
    return !TravelLeg.#startedBy(row, now);
  }

  /** A live leg that started before `now`: under way or done, history. */
  static #startedBy(row: ItemData | undefined, now: Date): boolean {
    return row?.deletedAt === null && row.startAt !== null && row.startAt < now;
  }

  /** What the reconciler reads of it; null when its props aren't a leg's or it has no start. */
  #facts(): StoredLegFacts | null {
    const key = this.key;
    const travel = this.travel;
    const startAt = this.data.startAt;
    if (key === null || travel === null || startAt === null) return null;
    return {
      id: this.id,
      key,
      startAt: new Date(startAt),
      anchorStart: new Date(travel.anchorStart),
      edited: travel.edited,
      removedReason: this.removedReason,
    };
  }

  /**
   * Its span after `change`: the fields given stand; with one alone, the length stands (a new
   * start or end), or the arrival (a new length; a leg back keeps its departure instead).
   */
  #spanAfter(
    change: LegTimesChange,
    given: readonly (keyof LegTimesChange)[],
    travel: TravelLegProps,
  ): Span {
    const { startAt, endAt } = this.data;
    const storedMinutes =
      startAt !== null && endAt !== null
        ? (endAt.getTime() - startAt.getTime()) / MINUTE_MS
        : travel.minutes;
    const edited: SpanField[] = given.map((field) => SPAN_FIELDS[field]);
    if (edited.length === 1) {
      const [only] = edited;
      if (only === 'minutes') edited.push(travel.direction === 'back' ? 'start' : 'end');
      else edited.push('minutes');
    }
    const span = solveSpan(
      {
        start: change.startAt ?? startAt,
        end: change.endAt ?? endAt,
        minutes: change.minutes ?? storedMinutes,
      },
      edited,
    );
    if (span === null) throw new ValidationError('endAt: travel ends after it starts');
    if (span.minutes > MAX_MINUTES) {
      throw new ValidationError(`minutes: travel lasts at most ${String(MAX_MINUTES)} minutes`);
    }
    return span;
  }

  /**
   * Writes what `change` makes of the leg as last read, guarded by that read's `updatedAt`: when a
   * regeneration changed it in between, it reads again and makes the change on that (409 after
   * SAVE_ATTEMPTS tries). The leg as now stored.
   */
  async #save(change: (current: TravelLeg) => ScheduledItemPatch): Promise<TravelLeg> {
    const items = await getItemRepository();
    let reread: TravelLeg | undefined;
    for (let attempt = 0; attempt < SAVE_ATTEMPTS; attempt += 1) {
      const current = reread ?? this;
      const updated = await items.updateScheduled(
        this.workspaceId,
        this.id,
        'travel',
        change(current),
        { unchangedSince: current.data.updatedAt },
      );
      if (updated !== null) return TravelLeg.#of(Item.from(updated));
      const stored = await items.findById(this.workspaceId, this.id);
      if (stored === null) throw new NotFoundError();
      reread = TravelLeg.#of(Item.from(stored));
    }
    throw new AppError(409, 'The travel changed while it was saved: try again');
  }

  /** A skipped leg live again, as it was, with its edit and flags cleared. */
  async #restore(travel: TravelLegProps): Promise<TravelLeg> {
    const key = this.key;
    const owner = this.ownerUserId;
    const { startAt, endAt } = this.data;
    if (key === null || owner === null || startAt === null || endAt === null) return this;
    const { item } = await (
      await getItemRepository()
    ).upsertTravelLeg(this.workspaceId, key, {
      ownerUserId: owner,
      title: this.data.title,
      topicId: this.data.topicId,
      startAt,
      endAt,
      travel: {
        ...travel,
        edited: false,
        anchorMoved: false,
        anchorStartNow: null,
        removedReason: null,
      },
    });
    return TravelLeg.#of(Item.from(item));
  }

  /** The leg a planned leg writes: new, or over the stored one (keeping his times if he edited it). */
  static #write(
    owner: string,
    leg: PlannedLeg,
    places: PlaceNames,
    now: Date,
    stored: { row: ItemData; keepTimes: boolean; anchorMoved: boolean } | null,
  ): TravelLegWrite {
    const prior = stored === null ? null : travelPropsOf(stored.row.props);
    const kept = TravelLeg.#keptTimes(stored, prior, leg);
    const moved = kept !== null && stored?.anchorMoved === true;
    const sameLength =
      prior !== null &&
      prior.minutes === leg.minutes &&
      prior.source === leg.source &&
      prior.mode === leg.mode &&
      prior.fromPlaceId === leg.fromPlaceId &&
      prior.toPlaceId === leg.toPlaceId;
    const nameOf = (id: string, before: string | undefined): string =>
      places.names.get(id) ?? before ?? '';
    const travel: TravelLegProps = {
      anchorItemId: leg.key.anchorItemId,
      occurrence: leg.key.occurrence,
      // An edited leg keeps the anchor start his edit was made against (his next edit or a reset
      // moves it on).
      anchorStart: kept?.prior.anchorStart ?? leg.anchorStart.toISOString(),
      direction: leg.key.direction,
      mode: leg.mode,
      fromPlaceId: leg.fromPlaceId,
      fromName: nameOf(leg.fromPlaceId, prior?.fromName),
      toPlaceId: leg.toPlaceId,
      toName: nameOf(leg.toPlaceId, prior?.toName),
      fromHome: leg.fromPlaceId === places.homeId,
      toHome: leg.toPlaceId === places.homeId,
      minutes: kept?.prior.minutes ?? leg.minutes,
      source: kept?.prior.source ?? leg.source,
      // Worked out again only when its length or trip changed: an identical plan writes nothing.
      computedAt: kept?.prior.computedAt ?? (sameLength ? prior.computedAt : now.toISOString()),
      conflict: kept?.prior.conflict ?? leg.conflict,
      edited: kept !== null,
      anchorMoved: moved,
      // Where the anchor is now, so his next edit acknowledges the move.
      anchorStartNow: moved ? leg.anchorStart.toISOString() : null,
      removedReason: null,
    };
    return {
      ownerUserId: owner,
      title: leg.title,
      topicId: leg.topicId,
      startAt: kept?.startAt ?? leg.startAt,
      endAt: kept?.endAt ?? leg.endAt,
      travel: { ...travel },
    };
  }

  /**
   * His times and their props, when the stored leg he edited keeps them: not when the plan changed
   * its mode or either place (changing mode or place recomputes a leg; his length was for another
   * trip).
   */
  static #keptTimes(
    stored: { row: ItemData; keepTimes: boolean } | null,
    prior: TravelLegProps | null,
    leg: PlannedLeg,
  ): { prior: TravelLegProps; startAt: Date; endAt: Date } | null {
    if (stored === null || !stored.keepTimes || prior === null) return null;
    if (
      prior.mode !== leg.mode ||
      prior.fromPlaceId !== leg.fromPlaceId ||
      prior.toPlaceId !== leg.toPlaceId
    ) {
      return null;
    }
    const { startAt, endAt } = stored.row;
    return startAt === null || endAt === null ? null : { prior, startAt, endAt };
  }

  /** The caller's places by id, and their Home. */
  static async #placeNames(caller: Caller): Promise<PlaceNames> {
    const places = await Place.listOwn(caller);
    return {
      names: new Map(places.map((place) => [place.id, place.name])),
      homeId: places.find((place) => place.isHome)?.id ?? null,
    };
  }

  /** The caller's own legs, tombstones too, by start. */
  static async #listOwn(
    caller: Caller,
    filter: { from?: Date; to?: Date; ids?: readonly string[] },
  ): Promise<TravelLeg[]> {
    const rows = await (
      await getItemRepository()
    ).listTravelLegs(caller.workspaceId, {
      ownerUserId: caller.userId,
      ...filter,
      includeRemoved: true,
    });
    return rows.map((row) => TravelLeg.#of(Item.from(row)));
  }

  /** The leg, as a TravelLeg (a stored leg always is one); 404 for any other item. */
  static #of(item: Item): TravelLeg {
    if (!(item instanceof TravelLeg)) throw new NotFoundError();
    return item;
  }
}
