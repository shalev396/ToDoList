/**
 * The version history of one document (BUILDER.md §8, DATA.md §3.12): a generic class over the
 * DashboardVersions collection, the only code that reads or writes it.
 *
 * - Every write appends one entry: the RFC 6902 patch from the state before it to the state after
 *   it, the inverse, and a whole copy (a snapshot) at version 1 and every 10th version.
 * - Each write then prunes to the last 50 plus the versions it is told to keep (the published
 *   one). There are no transactions (standalone MongoDB): a crash between the document's write and
 *   the append leaves a gap, which undo and redo refuse (409) rather than guess.
 * - Rebuilding a past state, planning an undo and guarding an inverse stay pure
 *   (builder/history.ts); a read of the history (`HistoryTrail`) applies them.
 *
 * `TDoc` is the document's shape: what snapshots hold and what a rebuilt state is.
 */
import { createPatch } from 'rfc6902';

import {
  guardPatch,
  planUndo,
  redoSummary,
  stateAt,
  tryPatch,
  undoneVersions,
  undoSummary,
  type ExtraSnapshot,
} from '../../builder/history.js';
import type { PatchOperation } from '../../builder/ops.js';
import { AppError } from '../../errors/AppError.js';
import type { DashboardVersionData } from '../../models/definitions/DashboardVersion.js';
import { getDashboardVersionRepository } from '../../models/index.js';
import { KEEP_VERSIONS, SNAPSHOT_EVERY } from './limits.js';

/** A deep copy as plain JSON: what history patches are diffed from. */
function plain<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T;
}

/** Freezes a value and everything it holds (a Date's own fields; its time stays its slot). */
function deepFreeze<T>(value: T): T {
  if (typeof value === 'object' && value !== null && !Object.isFrozen(value)) {
    Object.freeze(value);
    for (const inner of Object.values(value)) deepFreeze(inner);
  }
  return value;
}

/** HistoryTrail's maker, handed to this module by the class itself: only History#read reads one. */
let newTrail: <TDoc>(entries: readonly DashboardVersionData[]) => HistoryTrail<TDoc>;

/** Who wrote a version: a person, or an agent key acting for them. */
export interface HistoryAuthor {
  readonly userId: string;
  readonly agentId: string | null;
}

/** One write, as the history records it. */
export interface HistoryWrite<TDoc> {
  version: number;
  patch: readonly PatchOperation[];
  inverse: readonly PatchOperation[];
  /** The whole state after the write: stored as the snapshot on every SNAPSHOT_EVERY-th version. */
  doc: TDoc;
  author: HistoryAuthor;
  summary: string;
}

/** A state and the version it is at: the head a rebuild may walk back from. */
export interface HistoryHead<TDoc> {
  version: number;
  state: TDoc;
}

/** A change from one state to another: both as plain JSON, the patch and its inverse. */
export interface HistoryDiff<TDoc> {
  before: TDoc;
  next: TDoc;
  patch: PatchOperation[];
  inverse: PatchOperation[];
}

/** A state rebuilt from the history, with the summary its new version takes. */
export interface HistoryRestore<TDoc> {
  state: TDoc;
  summary: string;
}

/**
 * One read of a history, newest first (everything pruning leaves): rebuilding a past state,
 * planning an undo or a redo. Deeply immutable (its entries, their patches and snapshots); reading
 * again is a new trail. Only History#read makes one (a private constructor, its maker module-scoped).
 */
export class HistoryTrail<TDoc> {
  static {
    newTrail = <T>(entries: readonly DashboardVersionData[]): HistoryTrail<T> =>
      new HistoryTrail<T>(entries);
  }

  readonly #entries: readonly DashboardVersionData[];

  private constructor(entries: readonly DashboardVersionData[]) {
    this.#entries = deepFreeze(structuredClone([...entries]));
    Object.freeze(this);
  }

  get entries(): readonly DashboardVersionData[] {
    return this.#entries;
  }

  /** The newest version the history holds, if any. */
  get newest(): number | undefined {
    return this.#entries[0]?.version;
  }

  /** The newest entry, if any. */
  get latest(): DashboardVersionData | undefined {
    return this.#entries[0];
  }

  /**
   * The state at `version`: forward from the nearest snapshot at or before it (a stored one or one
   * of `extra`), or back from `head`. Null when neither reaches. The trail holds what this
   * history's document wrote, so a rebuilt state has the document's shape.
   */
  stateAt(version: number, extra: readonly ExtraSnapshot[], head: HistoryHead<TDoc>): TDoc | null {
    return stateAt(this.#entries, version, extra, head) as TDoc | null;
  }

  /**
   * Reverts the newest `steps` versions (an agent's own only, past anyone else's) from `head`,
   * each inverse guarded, so if a later change touched the same blocks the undo is refused (409)
   * instead of editing the wrong ones. Nothing to undo: 409.
   */
  undo(
    head: HistoryHead<TDoc>,
    steps: number,
    agentId: string | null,
    extra: readonly ExtraSnapshot[],
  ): HistoryRestore<TDoc> {
    const targets = planUndo(this.#entries, steps, agentId);
    if (targets.length === 0) throw new AppError(409, 'Nothing to undo');
    let state = head.state;
    for (const target of targets) {
      const after = this.stateAt(target.version, extra, head);
      if (after === null) throw new AppError(409, 'That change is too old to undo');
      const next = tryPatch(state, guardPatch(target.inverse, after));
      if (next === null) {
        throw new AppError(409, 'Cannot undo: a later change edited the same blocks');
      }
      state = next;
    }
    return { state, summary: undoSummary(targets.map((target) => target.version)) };
  }

  /**
   * Re-applies what the newest version (an undo) reverted: the state from just before that undo.
   * Only right after an undo; an agent only redoes its own undo. 409 otherwise.
   */
  redo(head: HistoryHead<TDoc>, agentId: string | null): HistoryRestore<TDoc> {
    const latest = this.latest;
    const undone = latest === undefined ? null : undoneVersions(latest.summary);
    const ownUndo = agentId === null || latest?.actorAgentId === agentId;
    if (latest === undefined || undone === null || !ownUndo) {
      throw new AppError(409, 'Nothing to redo');
    }
    // The undo is the newest version, so its inverse applies to exactly the state it was made from.
    const next = tryPatch(head.state, latest.inverse);
    if (next === null) throw new AppError(409, 'Cannot redo: the history does not apply');
    return { state: next, summary: redoSummary(undone) };
  }
}

export class History<TDoc> {
  /** More than pruning ever leaves, with room for writes racing a prune. */
  static readonly #READ_LIMIT = 200;

  readonly #workspaceId: string;
  readonly #documentId: string;

  private constructor(workspaceId: string, documentId: string) {
    this.#workspaceId = workspaceId;
    this.#documentId = documentId;
    Object.freeze(this);
  }

  /** The history of one dashboard. */
  static of<TDoc>(workspaceId: string, dashboardId: string): History<TDoc> {
    return new History<TDoc>(workspaceId, dashboardId);
  }

  /** The change from `before` to `next`: both as plain JSON, the patch and its inverse. */
  static diff<TDoc>(before: TDoc, next: TDoc): HistoryDiff<TDoc> {
    const from = plain(before);
    const to = plain(next);
    return { before: from, next: to, patch: createPatch(from, to), inverse: createPatch(to, from) };
  }

  /** The forward patch alone (a dry run's diff). */
  static patchOf<TDoc>(before: TDoc, next: TDoc): PatchOperation[] {
    return createPatch(plain(before), plain(next));
  }

  /** The history as it is now, newest first (everything pruning leaves). */
  async read(): Promise<HistoryTrail<TDoc>> {
    return newTrail<TDoc>(await this.page(History.#READ_LIMIT));
  }

  /** The newest `limit` entries, newest first. */
  async page(limit: number): Promise<DashboardVersionData[]> {
    return (await getDashboardVersionRepository()).list(this.#workspaceId, this.#documentId, limit);
  }

  /** The first entry of a new document: no patch, the whole state as its snapshot. */
  async start(version: number, doc: TDoc, author: HistoryAuthor, summary: string): Promise<void> {
    await (
      await getDashboardVersionRepository()
    ).append(this.#workspaceId, {
      dashboardId: this.#documentId,
      version,
      patch: [],
      inverse: [],
      snapshot: doc as Record<string, unknown>,
      actorUserId: author.userId,
      actorAgentId: author.agentId,
      summary,
    });
  }

  /** Appends one write's entry, with a snapshot on every SNAPSHOT_EVERY-th version. */
  async append(write: HistoryWrite<TDoc>): Promise<void> {
    await (
      await getDashboardVersionRepository()
    ).append(this.#workspaceId, {
      dashboardId: this.#documentId,
      version: write.version,
      patch: [...write.patch],
      inverse: [...write.inverse],
      snapshot:
        write.version % SNAPSHOT_EVERY === 0 ? (write.doc as Record<string, unknown>) : null,
      actorUserId: write.author.userId,
      actorAgentId: write.author.agentId,
      summary: write.summary,
    });
  }

  /** Deletes every history of a workspace (its deletion). Returns how many entries. */
  static async removeAllIn(workspaceId: string): Promise<number> {
    return (await getDashboardVersionRepository()).deleteForWorkspace(workspaceId);
  }

  /** Prunes to the last KEEP_VERSIONS plus `keepVersions` (the published one). */
  async prune(keepVersions: readonly number[]): Promise<void> {
    await (
      await getDashboardVersionRepository()
    ).pruneKeeping(this.#workspaceId, this.#documentId, KEEP_VERSIONS, keepVersions);
  }
}
