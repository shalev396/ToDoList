/**
 * Whether Undo and Redo have anything to do, read from the history (`GET …/versions`, newest
 * first) the way the server plans them for a person in the UI (server/src/builder/history.ts
 * planUndo, undoneVersions):
 * - undo walks back from the newest version, skipping undos and the versions they undid; the
 *   creation (version 1) cannot be undone; a person undoes anyone's change, an agent's included;
 * - redo only follows an undo.
 */

interface HistoryEntryLike {
  version: number;
  summary: string | null;
}

/** `undo:v4,v3`: the versions an undo reverted. */
const UNDO_SUMMARY = /^undo:(v\d+(?:,v\d+)*)$/;

function undoneVersions(summary: string | null): number[] | null {
  const list = summary === null ? undefined : UNDO_SUMMARY.exec(summary)?.[1];
  return list === undefined ? null : list.split(',').map((part) => Number(part.slice(1)));
}

export function historyAvailability(entries: readonly HistoryEntryLike[]): {
  canUndo: boolean;
  canRedo: boolean;
} {
  const undone = new Set<number>();
  let canUndo = false;
  for (const entry of entries) {
    if (entry.version <= 1) {
      break;
    }
    if (undone.has(entry.version)) {
      continue;
    }
    const reverted = undoneVersions(entry.summary);
    if (reverted !== null) {
      for (const version of reverted) {
        undone.add(version);
      }
      continue;
    }
    canUndo = true;
    break;
  }
  const [newest] = entries;
  return { canUndo, canRedo: newest !== undefined && undoneVersions(newest.summary) !== null };
}
