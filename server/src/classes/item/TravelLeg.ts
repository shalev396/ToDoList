/**
 * A travel leg (docs/superpowers/specs/2026-11-17-travel-time-design.md, "Object model"): the time
 * TodoList adds to get its member to, from or between the places their day happens in. A local
 * item of kind `travel`, a sibling of TimeBlock under ScheduledItem: never Completable and never
 * Deletable (it is skipped instead: 409 `not_deletable`).
 *
 * A leg is private to its member: stored `visibility: 'private'` and owned by them, and ItemPolicy
 * reads a leg for its owner only, whatever its visibility says (Ruling 8). It has no subject, and
 * its topic is the one its anchor (the event it serves) has, written by each regeneration, so its
 * colour is the anchor's topic family; neither can be set on the leg by hand (400). What makes it
 * a leg is at `props.travel` (types/travel.ts), and its key (LegKey) at `props.travelKey`: one
 * leg per key.
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
 * - The member's own changes: how long its trip takes (every time: it is the trip's length, which
 *   every leg of the trip takes), times that move this leg only, a skip, a reset. Each is the
 *   owner's only (404 for anyone else) and an editor's (403).
 * - The member's own reads (plan Task 13): a leg's app links, worked out from the places' text on
 *   each read and never stored, and the day panel (each day's legs, and the ones removed, with
 *   why).
 *
 * Stored props that aren't a leg's read as none (`travel` is null): reads never throw on them.
 */
import type { Caller } from '../base/Caller.js';
import { DayPlanner, type PlannedLeg } from '../travel/DayPlanner.js';
import type { Reconciliation, StoredLegFacts } from '../travel/LegReconciler.js';
import { Place } from '../travel/Place.js';
import { TravelLinks } from '../travel/TravelLinks.js';
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
import { redactString } from '../../services/secretPatterns.js';
import { SUBJECT_ATTRIBUTE_KEY } from '../../types/attributes.js';
import { addLocalDays, wallDate, zonedTime } from '../../types/recurrence/zoned.js';
import {
  TRAVEL_DAYS_MAX,
  TRIP_MINUTES_MAX,
  travelPropsOf,
  type RemovalReason,
  type TravelDayView,
  type TravelDaysResponse,
  type TravelLegProps,
  type TravelLink,
} from '../../types/travel.js';
import { Item } from './Item.js';
import type { ItemEdit } from './ItemEdit.js';
import type { OverlayEdit } from './Overlay.js';
import { ScheduledItem } from './ScheduledItem.js';

const FROM_ITS_EVENT = 'travel takes it from its event';

/**
 * A change of a leg: `minutes` is how long its trip takes, every time (the trip's length);
 * `startAt` and `endAt` move this leg only (one alone keeps its length). At least one.
 */
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

const MINUTE_MS = 60_000;
const DAY_MS = 24 * 60 * MINUTE_MS;
const DAY_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;

/** A calendar date (`YYYY-MM-DD`, a real one) as its UTC midnight; 400 naming `field` else. */
function calendarDay(text: string, field: string): Date {
  const match = DAY_PATTERN.exec(text);
  const day =
    match === null
      ? null
      : new Date(Date.UTC(Number(match[1]), Number(match[2]) - 1, Number(match[3])));
  if (day === null || Number.isNaN(day.getTime()) || day.toISOString().slice(0, 10) !== text) {
    throw new ValidationError(`${field}: a date, YYYY-MM-DD`);
  }
  return day;
}
/** How often a change made on a stale read is read again and retried before a 409. */
const SAVE_ATTEMPTS = 5;

/** A leg's span: when it starts and ends, and so how long it is. */
interface LegSpan {
  start: Date;
  end: Date;
  minutes: number;
}

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

  /**
   * Editors, their own: the day panel from `from` to `to` (`YYYY-MM-DD`, both included, in the
   * workspace's zone), at most TRAVEL_DAYS_MAX days: every day with the legs that start in it and
   * the ones removed from it (why, and when). 400 for a date that isn't one, or a range that runs
   * backwards or is too long.
   */
  static async days(caller: Caller, from: string, to: string): Promise<TravelDaysResponse> {
    caller.require('editor');
    const first = calendarDay(from, 'from');
    const last = calendarDay(to, 'to');
    const count = Math.round((last.getTime() - first.getTime()) / DAY_MS) + 1;
    if (count < 1) throw new ValidationError('to: on or after from');
    if (count > TRAVEL_DAYS_MAX) {
      throw new ValidationError(`to: at most ${String(TRAVEL_DAYS_MAX)} days from from`);
    }
    const zone = caller.settings.timezone;
    const start = zonedTime(
      first.getUTCFullYear(),
      first.getUTCMonth() + 1,
      first.getUTCDate(),
      0,
      0,
      zone,
    );
    const { live, removed } = await TravelLeg.listDays(
      caller,
      start,
      addLocalDays(start, count, zone),
    );
    const days = new Map<string, TravelDayView>();
    for (let index = 0; index < count; index += 1) {
      const date = new Date(first.getTime() + index * DAY_MS).toISOString().slice(0, 10);
      days.set(date, { date, legs: [], removed: [] });
    }
    const dayOf = (leg: TravelLeg): TravelDayView | undefined =>
      leg.startAt === null ? undefined : days.get(wallDate(leg.startAt, zone));
    for (const leg of live) dayOf(leg)?.legs.push(leg.toSummary());
    for (const leg of removed) {
      const reason = leg.removedReason;
      const removedAt = leg.deletedAt;
      if (reason === null || removedAt === null) continue;
      const trip = leg.travel;
      dayOf(leg)?.removed.push({
        id: leg.id,
        title: redactString(leg.title),
        reason,
        removedAt: removedAt.toISOString(),
        // What the trip was, by name only, so a view can word it in its language.
        ...(trip === null
          ? {}
          : {
              mode: trip.mode,
              toHome: trip.toHome,
              toName: redactString(trip.toName),
            }),
      });
    }
    return { days: [...days.values()] };
  }

  // ─── The member's changes ─────────────────────────────────────────────────

  /**
   * The member's change of this leg (the owner's decision of 2026-11-18), two kinds he can tell
   * apart:
   * - `minutes`: how long its trip (from place, to place, mode) takes, every time. It is stored as
   *   the trip's length (TravelProfile#setTripLength), which every leg of that trip takes from the
   *   next regeneration on (TravelSetup#editLeg runs it), but the legs whose times he set by hand.
   *   This leg takes it at once: it keeps its arrival (a leg there or between) or its departure (a
   *   leg back), and stays as it was otherwise (a leg he never timed by hand still follows the
   *   plan).
   * - `startAt`, `endAt`: this leg only. One alone keeps its length (the new `minutes` when given),
   *   both are its span. The leg is then his (`edited`): a regeneration keeps his times until he
   *   resets it. A leg flagged "the event moved" is edited against the anchor's new start, so the
   *   flag clears.
   * Either way its source is `set`. 400 for nothing to change, or anything that isn't a span of
   * more than 0 and at most a day.
   *
   * `tripLength: false` leaves the trip's stored length alone: the length typed went to the rule
   * that draws this leg instead (TravelSetup#editLeg, when that rule sets its own `lengths`).
   */
  async editTimes(
    caller: Caller,
    change: LegTimesChange,
    options: { tripLength?: boolean } = {},
  ): Promise<TravelLeg> {
    this.#authorize(caller);
    if (this.isDeleted) {
      throw new AppError(409, 'This travel was skipped or removed: reset it before editing it');
    }
    const { startAt, endAt, minutes } = change;
    const byHand = startAt !== undefined || endAt !== undefined;
    if (!byHand && minutes === undefined) {
      throw new ValidationError('minutes: give minutes, startAt or endAt');
    }
    // Whole minutes, whether the length goes to the trip or to the rule that draws this leg.
    if (
      minutes !== undefined &&
      !(Number.isInteger(minutes) && minutes > 0 && minutes <= TRIP_MINUTES_MAX)
    ) {
      throw new ValidationError(
        `minutes: a whole number, more than 0 and at most ${String(TRIP_MINUTES_MAX)}`,
      );
    }
    const trip = this.travel;
    if (trip === null) throw new ValidationError('travel: this leg has no travel to edit');
    // The span is checked before anything is stored: a refused change leaves the trip as it was.
    this.#spanAfter(change, trip);
    if (minutes !== undefined && options.tripLength !== false) {
      // The trip's length first: it is what he asked for, and the next regeneration applies it.
      const key = DayPlanner.tripKey(trip.fromPlaceId, trip.toPlaceId, trip.mode);
      await (await TravelProfile.of(caller)).setTripLength(caller, key, minutes);
    }
    return this.#save((current) => {
      const travel = current.travel;
      if (travel === null) throw new ValidationError('travel: this leg has no travel to edit');
      const span = current.#spanAfter(change, travel);
      const edited = byHand || travel.edited;
      return {
        startAt: span.start,
        endAt: span.end,
        props: {
          ...current.data.props,
          travel: {
            ...travel,
            minutes: span.minutes,
            source: 'set',
            lengthUnset: false,
            computedAt: new Date().toISOString(),
            edited,
            // An edit after the event moved is made against its new start: it acknowledges it.
            ...(travel.anchorStartNow === null
              ? {}
              : { anchorStart: travel.anchorStartNow, anchorMoved: false, anchorStartNow: null }),
          },
        },
      };
    });
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
   * Its member's only (404 for anyone else), an editor's: the apps that open the trip (Waze for
   * driving, Google Maps directions in its mode), from each place's address as he typed it, or its
   * name when it has none. Worked out on each read, never stored, never given to an agent (plan
   * Ruling 10). None without a place to go to (it went since).
   */
  async links(caller: Caller): Promise<TravelLink[]> {
    this.#authorize(caller);
    const travel = this.travel;
    if (travel === null) return [];
    const places = new Map((await Place.listOwn(caller)).map((place) => [place.id, place]));
    const where = (id: string): string | null => {
      const place = places.get(id);
      return place === undefined ? null : (place.address ?? place.name);
    };
    return TravelLinks.for({
      mode: travel.mode,
      from: where(travel.fromPlaceId),
      to: where(travel.toPlaceId),
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

  /** A leg is skipped, never disabled (400): disabling its event removes it. */
  protected override applyDisabled(): Promise<Item> {
    return Promise.reject(
      new ValidationError('disabled: a trip is skipped, not disabled (disable its event instead)'),
    );
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
   * Its span after `change`: both times given are its span; one alone keeps its length (the new
   * `minutes` when given); a length alone keeps its arrival, or its departure for a leg back.
   */
  #spanAfter(change: LegTimesChange, travel: TravelLegProps): LegSpan {
    const stored = { start: this.data.startAt, end: this.data.endAt };
    const storedMinutes =
      stored.start !== null && stored.end !== null
        ? (stored.end.getTime() - stored.start.getTime()) / MINUTE_MS
        : travel.minutes;
    const length = (change.minutes ?? storedMinutes) * MINUTE_MS;
    const at = (date: Date | null): number => {
      if (date === null) throw new ValidationError('travel: this leg has no times to edit');
      return date.getTime();
    };
    let start: number;
    let end: number;
    if (change.startAt !== undefined && change.endAt !== undefined) {
      start = change.startAt.getTime();
      end = change.endAt.getTime();
    } else if (change.startAt !== undefined) {
      start = change.startAt.getTime();
      end = start + length;
    } else if (change.endAt !== undefined || travel.direction !== 'back') {
      end = change.endAt?.getTime() ?? at(stored.end);
      start = end - length;
    } else {
      start = at(stored.start);
      end = start + length;
    }
    if (!Number.isFinite(start) || !Number.isFinite(end) || end <= start) {
      throw new ValidationError('endAt: travel ends after it starts');
    }
    const minutes = (end - start) / MINUTE_MS;
    if (minutes > TRIP_MINUTES_MAX) {
      throw new ValidationError(
        `minutes: travel lasts at most ${String(TRIP_MINUTES_MAX)} minutes`,
      );
    }
    return { start: new Date(start), end: new Date(end), minutes };
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
    const source = kept?.prior.source ?? leg.source;
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
      source,
      lengthUnset: source === 'unset',
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
