/**
 * What a member's stored legs need so they match a fresh plan (docs/superpowers/specs/
 * 2026-11-17-travel-time-design.md, "Generation and lifecycle"). Pure: the stored facts, the
 * plan and each anchor's fate in; the creates, updates and removals out, which storage applies.
 * Legs are matched by key (LegKey), so reconciling a plan with its own result changes nothing.
 *
 * - A planned leg nobody stored is created, unless it is past.
 * - A planned leg stored live:
 *   - once the stored leg has started (under way or done), it is left alone: never shifted, never
 *     removed;
 *   - else, when the plan for it is past (its anchor moved earlier, into now or the past), it is
 *     removed as `moved`, since nobody can take it any more;
 *   - else it is updated. A leg the member edited keeps his times (`keepTimes`), and is flagged
 *     when its anchor moved since (`anchorMoved`): never silently shifted.
 * - A planned leg stored as a tombstone is restored, unless it is past or the member skipped it
 *   (only Reset brings a skip back).
 * - A live leg nobody plans any more is removed, unless it has started, with a reason he can see:
 *   its anchor's fate (`present`, so another leg took its place: `replaced`; no fate:
 *   `cancelled`).
 */
import type { RemovalReason } from '../../types/travel.js';
import type { PlannedLeg } from './DayPlanner.js';
import { LegKey } from './LegKey.js';

/** What became of an anchor occurrence, by `LegKey#anchorKey` (`anchorItemId|occurrence`). */
export type AnchorFate = 'present' | 'cancelled' | 'moved' | 'no_longer_matches' | 'no_place';

/**
 * A stored leg, as far as reconciling goes. For an edited leg, `anchorStart` is the anchor start
 * the member's edit was made against: storage keeps it while `keepTimes` holds, so the moved flag
 * stays until he resets the leg.
 */
export interface StoredLegFacts {
  id: string;
  key: string;
  startAt: Date;
  anchorStart: Date;
  edited: boolean;
  /** Null while the leg is live; a tombstone's reason otherwise. */
  removedReason: RemovalReason | null;
}

export interface Reconciliation {
  create: PlannedLeg[];
  update: {
    id: string;
    leg: PlannedLeg;
    /** The member edited it: keep his start, end and length. */
    keepTimes: boolean;
    /** He edited it and its anchor has moved since ("the event moved; check this trip"). */
    anchorMoved: boolean;
    /** It was a tombstone: make it live again. */
    restore: boolean;
  }[];
  remove: { id: string; reason: RemovalReason }[];
}

/** An anchor's fate as the reason its leg went. */
const REASONS: Readonly<Record<AnchorFate, RemovalReason>> = {
  present: 'replaced',
  cancelled: 'cancelled',
  moved: 'moved',
  no_longer_matches: 'no_longer_matches',
  no_place: 'no_place',
};

export class LegReconciler {
  readonly #now: Date;
  readonly #fates: ReadonlyMap<string, AnchorFate>;

  private constructor(fates: ReadonlyMap<string, AnchorFate>, now: Date) {
    this.#fates = fates;
    this.#now = now;
  }

  /**
   * The changes that bring `stored` in line with `planned`. Each list keeps its input's order:
   * `planned` for creates and updates; for removals, the legs whose plan went past (in `planned`
   * order), then the legs nobody plans (in `stored` order). A key planned twice counts once.
   */
  static reconcile(
    stored: readonly StoredLegFacts[],
    planned: readonly PlannedLeg[],
    fates: ReadonlyMap<string, AnchorFate>,
    now: Date,
  ): Reconciliation {
    return new LegReconciler(fates, now).#run(stored, planned);
  }

  #run(stored: readonly StoredLegFacts[], planned: readonly PlannedLeg[]): Reconciliation {
    const byKey = new Map<string, StoredLegFacts>();
    for (const leg of stored) if (!byKey.has(leg.key)) byKey.set(leg.key, leg);
    const recon: Reconciliation = { create: [], update: [], remove: [] };
    const plannedKeys = new Set<string>();
    for (const leg of planned) {
      const key = leg.key.toString();
      if (plannedKeys.has(key)) continue;
      plannedKeys.add(key);
      const facts = byKey.get(key);
      if (facts === undefined) {
        if (!leg.past) recon.create.push(leg);
      } else if (facts.removedReason === null) {
        // A leg under way (or done) is history: it never shifts and never goes.
        if (facts.startAt < this.#now) continue;
        // Its anchor moved earlier, into now or the past: this leg can't be taken any more.
        if (leg.past) recon.remove.push({ id: facts.id, reason: 'moved' });
        else recon.update.push(LegReconciler.#update(facts, leg, false));
      } else if (facts.removedReason !== 'skipped' && !leg.past) {
        recon.update.push(LegReconciler.#update(facts, leg, true));
      }
    }
    for (const facts of stored) {
      const live = facts.removedReason === null;
      if (live && !plannedKeys.has(facts.key) && facts.startAt >= this.#now) {
        recon.remove.push({ id: facts.id, reason: this.#reasonFor(facts.key) });
      }
    }
    return recon;
  }

  static #update(
    facts: StoredLegFacts,
    leg: PlannedLeg,
    restore: boolean,
  ): Reconciliation['update'][number] {
    return {
      id: facts.id,
      leg,
      keepTimes: facts.edited,
      anchorMoved: facts.edited && facts.anchorStart.getTime() !== leg.anchorStart.getTime(),
      restore,
    };
  }

  /** Why the leg under `key` went: its anchor's fate, `cancelled` when it has none. */
  #reasonFor(key: string): RemovalReason {
    const anchorKey = LegKey.tryParse(key)?.anchorKey;
    const fate = anchorKey === undefined ? undefined : this.#fates.get(anchorKey);
    return fate === undefined ? 'cancelled' : REASONS[fate];
  }
}
