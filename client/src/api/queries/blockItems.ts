import { useCallback } from 'react';
import { useMutation, useQueryClient, type QueryKey } from '@tanstack/react-query';
import { completeItem, setItemStatus } from '@/api/services/blockItemService';
import { patchForStatus, patchRow } from '@/features/dashboards/blocks/data/optimistic';
import { workspaceKey } from '@/features/workspaces/switching';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { ItemStatus } from '@api-types/domain';

type Snapshot = [QueryKey, unknown][];

interface ItemWrite {
  id: string;
  status: ItemStatus;
}

/**
 * Writes to local items from blocks (complete a to-do, move a card): the cached block results show
 * the new status at once, go back when the server refuses, and refetch when the write settles.
 * A mirrored item is never written here; callers only offer it for local ones.
 */
function useItemWrite(write: (workspaceId: string, item: ItemWrite) => Promise<unknown>) {
  const queryClient = useQueryClient();
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? null;
  const blocksKey = workspaceId === null ? null : workspaceKey(workspaceId, 'block');

  return useMutation<unknown, Error, ItemWrite, Snapshot>({
    mutationFn: async (item) => {
      if (workspaceId === null) {
        throw new Error('No workspace');
      }
      await write(workspaceId, item);
    },
    onMutate: async (item) => {
      if (blocksKey === null) {
        return [];
      }
      // Patch first, synchronously, so a controlled checkbox never flips back for a tick; then stop
      // refetches already in flight from overwriting the patch.
      const snapshot: Snapshot = queryClient.getQueriesData({ queryKey: blocksKey });
      const patch = patchForStatus(item.status, new Date());
      queryClient.setQueriesData({ queryKey: blocksKey }, (data: unknown) =>
        patchRow(data, item.id, patch),
      );
      await queryClient.cancelQueries({ queryKey: blocksKey });
      return snapshot;
    },
    onError: (_error, _item, snapshot) => {
      for (const [key, data] of snapshot ?? []) {
        queryClient.setQueryData(key, data);
      }
    },
    onSettled: async () => {
      if (blocksKey !== null) {
        await queryClient.invalidateQueries({ queryKey: blocksKey });
      }
    },
  });
}

/** Tick or untick a local to-do. */
export function useCompleteItem() {
  const mutation = useItemWrite((workspaceId, item) =>
    completeItem(workspaceId, item.id, item.status === 'done', { suppressErrorToast: false }),
  );
  return useCallback(
    (id: string, done: boolean) => {
      mutation.mutate({ id, status: done ? 'done' : 'open' });
    },
    [mutation],
  );
}

/** Move a local item to a status (the kanban's drop). */
export function useSetItemStatus() {
  const mutation = useItemWrite((workspaceId, item) =>
    setItemStatus(workspaceId, item.id, item.status),
  );
  return useCallback(
    (id: string, status: ItemStatus) => {
      mutation.mutate({ id, status });
    },
    [mutation],
  );
}
