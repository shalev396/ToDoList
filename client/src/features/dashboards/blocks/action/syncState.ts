export type SyncOutcome = 'none' | 'running' | 'succeeded' | 'partial' | 'failed';

/**
 * Where a "sync now" stands: the runs it queued (`runIds`, from the 202) looked up in the sync-run
 * history. Running until every one has finished (a run missing from the history is still queued);
 * then the worst outcome. `none` when nothing was ready to sync.
 */
export function syncOutcome(
  runIds: readonly string[],
  history: readonly { id: string; status: string }[],
): SyncOutcome {
  if (runIds.length === 0) {
    return 'none';
  }
  let worst: SyncOutcome = 'succeeded';
  for (const id of runIds) {
    const status = history.find((entry) => entry.id === id)?.status;
    if (status === undefined || status === 'queued' || status === 'running') {
      return 'running';
    }
    if (status === 'partial' && worst === 'succeeded') {
      worst = 'partial';
    } else if (status === 'failed') {
      worst = 'failed';
    }
  }
  return worst;
}
