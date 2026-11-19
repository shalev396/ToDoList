import { useStore } from 'react-redux';
import { useMutation, useQueryClient } from '@tanstack/react-query';
import { queryKeys } from '@/api/queries/keys';
import { sameWorkspace } from '@/api/queries/sameWorkspace';
import { refreshAfterChange } from '@/api/queries/travelCache';
import { createTimeBlock, editTimeBlock, skipOccurrence } from '@/api/services/timeBlockService';
import type { RootState } from '@/store';
import type {
  CreateTimeBlockRequest,
  EditTimeBlockRequest,
  SkipOccurrenceRequest,
  TimeBlockResponseData,
} from '@api-types/timeBlocks.ts';

/**
 * A write that answers the block as stored: it replaces the cached item, and the blocks' data
 * (calendar, clock, timeline, agenda) refetch. A body that names a subject may have added it to the
 * workspace's Subject select, so the attributes and the catalog refetch too. Skipped when the
 * workspace changed in flight.
 */
function useTimeBlockWrite<V>(
  workspaceId: string,
  call: (body: V) => Promise<TimeBlockResponseData>,
  namesSubject: (body: V) => boolean = () => false,
) {
  const queryClient = useQueryClient();
  const store = useStore<RootState>();
  return useMutation({
    mutationFn: call,
    ...sameWorkspace(
      () => store.getState().workspace.generation,
      (block: TimeBlockResponseData, body: V) => {
        queryClient.setQueryData(queryKeys.item(workspaceId, block.id), block);
        refreshAfterChange(queryClient, workspaceId);
        if (namesSubject(body)) {
          void queryClient.invalidateQueries({ queryKey: queryKeys.attributes(workspaceId) });
          void queryClient.invalidateQueries({ queryKey: queryKeys.catalog(workspaceId) });
        }
      },
    ),
  });
}

/** A new time block or area (editors and up). */
export function useCreateTimeBlock(workspaceId: string) {
  return useTimeBlockWrite(
    workspaceId,
    async (body: CreateTimeBlockRequest) => {
      const response = await createTimeBlock(workspaceId, body, { suppressErrorToast: true });
      return response.data;
    },
    (body) => typeof body.subject === 'string',
  );
}

/** "This one" (an occurrence's times) or "All" (the series). */
export function useEditTimeBlock(workspaceId: string, blockId: string) {
  return useTimeBlockWrite(
    workspaceId,
    async (body: EditTimeBlockRequest) => {
      const response = await editTimeBlock(workspaceId, blockId, body, {
        suppressErrorToast: true,
      });
      return response.data;
    },
    (body) => typeof body.subject === 'string',
  );
}

/** Leaves one occurrence of a repeating block out. */
export function useSkipOccurrence(workspaceId: string, blockId: string) {
  return useTimeBlockWrite(workspaceId, async (body: SkipOccurrenceRequest) => {
    const response = await skipOccurrence(workspaceId, blockId, body, { suppressErrorToast: true });
    return response.data;
  });
}
