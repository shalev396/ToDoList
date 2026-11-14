import { useQuery } from '@tanstack/react-query';
import { blockQueryOptions } from '@/api/queries/blockQuery';
import { runQuery } from '@/api/services/queryService';
import { useBlockEntry } from '@/features/dashboards/registry/blockEntryContext';
import type { PageVars } from '@/features/dashboards/variables/urlVars';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { Block } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';

export { blockHasData } from '@/api/queries/blockQuery';

/**
 * One block's result (FRONTEND.md §6): one `POST /query` with `{dashboardId, blockId, vars}`, the
 * draft for editors and the published copy for viewers (the server decides by role). The options
 * are blockQueryOptions (tested in Node):
 *
 * - Only the variables the block listens to or its query refers to are sent and hashed into the
 *   key, so changing any other variable never refetches it.
 * - Fresh for `QUERY_STALE_TIME_PRIVATE_MS`, and refetched when the window regains focus once
 *   stale (the app's other queries are not). The block's registry entry may refetch on an
 *   interval (the clock and calendar, every minute); the grid's BlockSlot gives the entry through
 *   BlockEntryContext, so this data layer never imports the registry, whose blocks import it.
 * - While new variables load, the previous result stays (no skeleton flash on filter churn).
 * - Blocks without data (filter, action, note) never fetch.
 */
export function useBlockData(dashboard: DashboardView, block: Block, vars: PageVars) {
  const { workspace } = useCurrentWorkspace();
  const refetchIntervalMs = useBlockEntry()?.refetchIntervalMs;
  return useQuery(
    blockQueryOptions({
      workspaceId: workspace?.id ?? null,
      dashboardId: dashboard.id,
      block,
      vars,
      refetchIntervalMs,
      run: async (workspaceId, body, signal) => {
        const response = await runQuery(workspaceId, body, { signal, suppressErrorToast: true });
        return response.data;
      },
    }),
  );
}
