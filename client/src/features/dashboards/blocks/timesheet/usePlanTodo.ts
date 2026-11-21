import { useStore } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { refreshAfterChange } from '@/api/queries/travelCache';
import { updateOverlay } from '@/api/services/itemService';
import { workspaceKey } from '@/features/workspaces/switching';
import type { RootState } from '@/store';
import type { QueryResult } from '@api-types/builder';
import { withPlan } from './timesheetModel';

export interface PlanChange {
  itemId: string;
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` on the workspace's wall clock; null unschedules. */
  plannedAt: string | null;
}

/**
 * Plans a to-do from the timesheet (or takes its plan off) through the overlay route ItemSheet's
 * "Planned for" uses (`PATCH …/items/:id/overlay {plannedAt}`): never written to its provider. The
 * block's cached results take the new plan at once, so the chip moves under the finger; a refusal
 * puts them back and says so. Afterwards (after the last of several quick ones) the blocks and the
 * item read again, unless the workspace changed while it ran.
 */
export function usePlanTodo(workspaceId: string, dashboardId: string, blockId: string) {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const store = useStore<RootState>();
  const generation = () => store.getState().workspace.generation;
  const blockKey = workspaceKey(workspaceId, 'block', dashboardId, blockId);
  const mutationKey = ['timesheet-plan', workspaceId, dashboardId, blockId];
  return useMutation({
    mutationKey,
    mutationFn: async ({ itemId, plannedAt }: PlanChange) => {
      const response = await updateOverlay(
        workspaceId,
        itemId,
        { plannedAt },
        { suppressErrorToast: true },
      );
      return response.data;
    },
    onMutate: async ({ itemId, plannedAt }: PlanChange) => {
      await queryClient.cancelQueries({ queryKey: blockKey });
      const snapshot = queryClient.getQueriesData<QueryResult>({ queryKey: blockKey });
      queryClient.setQueriesData<QueryResult>({ queryKey: blockKey }, (data) =>
        withPlan(data, itemId, plannedAt),
      );
      return { snapshot, generation: generation() };
    },
    onError: (_error, _change, context) => {
      if (context?.generation !== generation()) {
        return;
      }
      for (const [key, data] of context.snapshot) {
        queryClient.setQueryData(key, data);
      }
      toast.error(t('timeBlocks.timesheet.planFailed'));
    },
    onSuccess: (updated, { itemId }, context) => {
      if (context.generation === generation()) {
        queryClient.setQueryData(queryKeys.item(workspaceId, itemId), updated);
      }
    },
    onSettled: (_data, _error, _change, context) => {
      // Read again only after the last of several quick plans: a read in between would bring a
      // stale plan back under a chip that has already moved on.
      if (context?.generation === generation() && queryClient.isMutating({ mutationKey }) === 1) {
        refreshAfterChange(queryClient, workspaceId);
      }
    },
  });
}
