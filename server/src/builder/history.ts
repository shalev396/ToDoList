/**
 * Dashboard version history (BUILDER.md §8, DATA.md §3.12): rebuilding a past state, planning an
 * undo, and guarding an inverse patch. Pure: the dashboards service loads the versions.
 *
 * Every version stores the RFC 6902 patch from the state before it to the state after it, and the
 * inverse; version 1 and every 10th version also store the whole state (a snapshot).
 */
import { Pointer, applyPatch, type Operation } from 'rfc6902';

import type { DashboardDraft } from '../types/builder.js';
import { toPointer } from './errors.js';

/** What history needs of one stored version. */
export interface HistoryEntry {
  version: number;
  patch: readonly unknown[];
  inverse: readonly unknown[];
  /** The whole state after this version, or null. */
  snapshot: unknown;
  actorAgentId: string | null;
  summary: string | null;
}

/** A whole state at a version that is not (or no longer) a stored snapshot: the published copy. */
export interface ExtraSnapshot {
  version: number;
  state: unknown;
}

/**
 * The summary of a version a data migration wrote as the new start of a dashboard's history: its
 * snapshot is the state, and older versions are gone. Undo does not go back past it.
 */
export const HISTORY_RESET_SUMMARY = 'history-reset';

const UNDO_SUMMARY = /^undo:(v\d+(?:,v\d+)*)$/;

function versionList(versions: readonly number[]): string {
  return versions.map((version) => `v${String(version)}`).join(',');
}

/** The summary of an undo version: `undo:v4,v3` (the versions it reverted, newest first). */
export function undoSummary(versions: readonly number[]): string {
  return `undo:${versionList(versions)}`;
}

/** The summary of a redo version: `redo:v4,v3` (the versions it re-applied). */
export function redoSummary(versions: readonly number[]): string {
  return `redo:${versionList(versions)}`;
}

/** The versions an undo reverted (`undo:v4,v3` → [4, 3]); null when the summary is not an undo's. */
export function undoneVersions(summary: string | null): number[] | null {
  const list = summary === null ? undefined : UNDO_SUMMARY.exec(summary)?.[1];
  if (list === undefined) return null;
  return list.split(',').map((part) => Number(part.slice(1)));
}

/**
 * Applies a patch to a copy of `state`: the result, or null when any operation fails (a `test`, a
 * missing path). Neither `state` nor `patch` is changed.
 */
export function tryPatch<T>(state: T, patch: readonly unknown[]): T | null {
  const copy = structuredClone(state);
  const results = applyPatch(copy, structuredClone(patch) as Operation[]);
  return results.every((result) => result === null) ? copy : null;
}

/**
 * The state after version `target`. Forward first: the nearest snapshot at or before it (a stored
 * one, or one of `extra`), then every forward patch after it. When no snapshot reaches (pruned), and
 * a `head` (the current state and its version) is given: backward from the head, applying the
 * inverses of the head's version down to target + 1. Null when neither way reaches (a version in
 * between was pruned) or a patch does not apply.
 */
export function stateAt(
  entries: readonly HistoryEntry[],
  target: number,
  extra: readonly ExtraSnapshot[] = [],
  head?: ExtraSnapshot,
): DashboardDraft | null {
  const byVersion = new Map(entries.map((entry) => [entry.version, entry]));
  return forwardTo(entries, byVersion, target, extra) ?? backwardTo(byVersion, target, head);
}

function forwardTo(
  entries: readonly HistoryEntry[],
  byVersion: ReadonlyMap<number, HistoryEntry>,
  target: number,
  extra: readonly ExtraSnapshot[],
): DashboardDraft | null {
  const snapshots: ExtraSnapshot[] = [
    ...entries
      .filter((entry) => entry.snapshot !== null && entry.snapshot !== undefined)
      .map((entry) => ({ version: entry.version, state: entry.snapshot })),
    ...extra,
  ];
  let base: ExtraSnapshot | undefined;
  for (const snapshot of snapshots) {
    if (snapshot.version <= target && (base === undefined || snapshot.version > base.version)) {
      base = snapshot;
    }
  }
  if (base === undefined) return null;
  let state: unknown = structuredClone(base.state);
  for (let version = base.version + 1; version <= target; version += 1) {
    const entry = byVersion.get(version);
    if (entry === undefined) return null;
    const next = tryPatch(state, entry.patch);
    if (next === null) return null;
    state = next;
  }
  return state as DashboardDraft;
}

/** Each version's inverse turns the state after it into the state before it, exactly. */
function backwardTo(
  byVersion: ReadonlyMap<number, HistoryEntry>,
  target: number,
  head: ExtraSnapshot | undefined,
): DashboardDraft | null {
  if (head === undefined || target > head.version) return null;
  let state: unknown = structuredClone(head.state);
  for (let version = head.version; version > target; version -= 1) {
    const entry = byVersion.get(version);
    // A history reset has no inverse: what came before it is gone.
    if (entry === undefined || entry.summary === HISTORY_RESET_SUMMARY) return null;
    const previous = tryPatch(state, entry.inverse);
    if (previous === null) return null;
    state = previous;
  }
  return state as DashboardDraft;
}

/**
 * The versions an undo of `steps` reverts, newest first. Walking back from the newest version:
 * - an undo is skipped, and so are the versions it already undid;
 * - version 1 (the creation) and a history reset (a migration's new start) end the walk: neither
 *   can be undone;
 * - an agent (`agentId`) only undoes its own versions and skips everyone else's; a person undoes
 *   anyone's. A redo is an ordinary version: undoing it undoes the redo.
 * `entries` is newest first.
 */
export function planUndo(
  entries: readonly HistoryEntry[],
  steps: number,
  agentId: string | null,
): HistoryEntry[] {
  const undone = new Set<number>();
  const targets: HistoryEntry[] = [];
  for (const entry of entries) {
    if (targets.length >= steps || entry.version <= 1) break;
    if (entry.summary === HISTORY_RESET_SUMMARY) break;
    if (undone.has(entry.version)) continue;
    const reverted = undoneVersions(entry.summary);
    if (reverted !== null) {
      for (const version of reverted) undone.add(version);
      continue;
    }
    if (agentId !== null && entry.actorAgentId !== agentId) continue;
    targets.push(entry);
  }
  return targets;
}

/** Arrays whose elements carry an id: testing the id pins the element (its other fields may move). */
const ID_KEYS: readonly [RegExp, string][] = [
  [/^\/blocks$/, 'id'],
  [/^\/layouts\/(?:lg|md|sm)$/, 'i'],
];

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function valueAt(state: unknown, path: string): unknown {
  try {
    return Pointer.fromJSON(path).get(state) as unknown;
  } catch {
    return undefined;
  }
}

/**
 * Tests that pin every array element an op at `path` reaches into (not the element it targets
 * itself): a block or a layout item by its id; any other element (a query rule, a sort entry, a
 * display rule) whole, as it is in `state`. An index that now points at something else fails.
 */
function containerTests(path: string, state: unknown): Operation[] {
  const { tokens } = Pointer.fromJSON(path);
  const tests: Operation[] = [];
  let node: unknown = state;
  for (let index = 1; index < tokens.length - 1; index += 1) {
    const token = tokens[index] ?? '';
    if (Array.isArray(node)) {
      const element: unknown = node[Number(token)];
      if (element === undefined) break;
      const elementPath = toPointer(tokens.slice(1, index + 1));
      const idKey = ID_KEYS.find(([pattern]) =>
        pattern.test(toPointer(tokens.slice(1, index))),
      )?.[1];
      if (idKey === undefined) {
        tests.push({ op: 'test', path: elementPath, value: structuredClone(element) });
      } else if (isRecord(element) && element[idKey] !== undefined) {
        tests.push({ op: 'test', path: `${elementPath}/${idKey}`, value: element[idKey] });
      }
      node = element;
    } else {
      node = isRecord(node) ? node[token] : undefined;
    }
  }
  return tests;
}

/**
 * `patch` with guards, for applying it to a state that may have moved on since `after`, the state
 * it was made against (an undo past other people's changes):
 * - before an operation inside an array element, a `test` pinning that element: a block or a layout
 *   item by its id, anything else (a query rule, a display rule) whole. An index that now points at
 *   another block or rule fails instead of editing it;
 * - before a `remove` or `replace`, a `test` of the value it removes or replaces.
 * The tests are worked out on a copy of `after`, so each sees the state as the patch's earlier
 * operations leave it. Applied to `after` itself, the guarded patch does exactly what `patch` does.
 */
export function guardPatch(patch: readonly unknown[], after: unknown): Operation[] {
  const shadow: unknown = structuredClone(after);
  const guarded: Operation[] = [];
  for (const op of structuredClone(patch) as Operation[]) {
    guarded.push(...containerTests(op.path, shadow));
    if (op.op === 'remove' || op.op === 'replace') {
      const current = valueAt(shadow, op.path);
      if (current !== undefined) {
        guarded.push({ op: 'test', path: op.path, value: structuredClone(current) });
      }
    }
    guarded.push(op);
    applyPatch(shadow, [structuredClone(op)]);
  }
  return guarded;
}
