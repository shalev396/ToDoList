import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { useApplyDashboardOps } from '@/api/queries/dashboards';
import { queryKeys } from '@/api/queries/keys';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { Block } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';

/**
 * Saves the calendar's Week/Month choice or start hour in the block's viz options (one `update_block` op), for
 * an editor or owner on the draft. Anyone else keeps the choice for the visit only. The cache is
 * updated by hand with the new version, so the editor's next layout save doesn't conflict.
 */
export function useSaveCalendarViz(dashboard: DashboardView, block: Block) {
  const { t } = useTranslation();
  const { workspace, role } = useCurrentWorkspace();
  const queryClient = useQueryClient();
  const workspaceId = workspace?.id ?? '';
  const apply = useApplyDashboardOps(workspaceId, dashboard.id);
  const canSave =
    workspace !== null && dashboard.as === 'draft' && (role === 'editor' || role === 'owner');

  return (patch: { view?: 'week' | 'month'; startHour?: number }) => {
    if (!canSave) {
      return;
    }
    const viz = { ...block.viz, ...patch };
    apply.mutate(
      {
        expectedVersion: dashboard.version,
        ops: [{ op: 'update_block', blockId: block.id, patch: { viz } }],
      },
      {
        onSuccess: (result) => {
          if (!('version' in result)) {
            return;
          }
          queryClient.setQueryData<DashboardView>(
            queryKeys.dashboard(workspaceId, dashboard.id, 'draft'),
            (cached) =>
              cached === undefined
                ? cached
                : {
                    ...cached,
                    version: result.version,
                    publishedVersion: role === 'owner' ? result.version : cached.publishedVersion,
                    blocks: cached.blocks.map((b) => (b.id === block.id ? { ...b, viz } : b)),
                  },
          );
        },
        onError: () => {
          toast.error(t('timeBlocks.calendar.saveFailed'));
        },
      },
    );
  };
}
