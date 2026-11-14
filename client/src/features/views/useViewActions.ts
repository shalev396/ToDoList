import { useCallback, useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import { apiConflictVersion, errorMessage } from '@/api/errors';
import { queryKeys } from '@/api/queries/keys';
import { useApplyDashboardOps } from '@/api/queries/dashboards';
import type { PageView, ViewConfig, ViewType } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';
import { addedView } from './viewModel';

/** What "Add view" asks for: a custom type, or a view template. */
export type NewView =
  | { kind: 'custom'; type: ViewType; title?: string | undefined; config?: ViewConfig | undefined }
  | { kind: 'template'; templateKey: string; title?: string | undefined };

interface ViewActionsInput {
  workspaceId: string;
  dashboard: DashboardView;
  language: 'en' | 'he';
  /** Saves layout changes still waiting, so the write starts from the newest version. */
  flush: () => void;
}

export interface ViewActions {
  /** Adds the view and resolves with it (null: it failed, the reason was shown). */
  addView: (view: NewView, shareIntegrations?: boolean) => Promise<PageView | null>;
  renameView: (viewId: string, title: string) => Promise<boolean>;
  moveView: (viewId: string, index: number) => Promise<boolean>;
  removeView: (viewId: string) => Promise<boolean>;
  /** A write is in flight. */
  pending: boolean;
}

/**
 * The view writes (H3): `add_view`, `update_view`, `move_view` and `remove_view` ops, each one
 * version of the page (so Undo and Redo cover them, as the agent ops do). The page is refetched
 * after each; a 409 says the page changed elsewhere.
 */
export function useViewActions({
  workspaceId,
  dashboard,
  language,
  flush,
}: ViewActionsInput): ViewActions {
  const { t } = useTranslation();
  const queryClient = useQueryClient();
  const applyOps = useApplyDashboardOps(workspaceId, dashboard.id);
  const [pending, setPending] = useState(false);
  const draftKey = queryKeys.dashboard(workspaceId, dashboard.id, 'draft');

  const write = useCallback(
    async (ops: unknown[], shareIntegrations?: boolean): Promise<DashboardView | null> => {
      flush();
      setPending(true);
      const before = queryClient.getQueryData<DashboardView>(draftKey) ?? dashboard;
      try {
        await applyOps.mutateAsync({
          expectedVersion: before.version,
          ops,
          language,
          ...(shareIntegrations === undefined ? {} : { shareIntegrations }),
        });
        await Promise.all([
          queryClient.invalidateQueries({
            queryKey: queryKeys.dashboardCopies(workspaceId, dashboard.id),
          }),
          queryClient.invalidateQueries({
            queryKey: queryKeys.dashboardVersions(workspaceId, dashboard.id),
          }),
        ]);
        return queryClient.getQueryData<DashboardView>(draftKey) ?? null;
      } catch (failure) {
        if (apiConflictVersion(failure) !== null) {
          toast.error(t('dashboard.conflict'));
          await queryClient.invalidateQueries({
            queryKey: queryKeys.dashboardCopies(workspaceId, dashboard.id),
          });
        } else {
          toast.error(errorMessage(t, failure, 'views.saveFailed'));
        }
        return null;
      } finally {
        setPending(false);
      }
    },
    [applyOps, dashboard, draftKey, flush, language, queryClient, t, workspaceId],
  );

  const addView = useCallback(
    async (view: NewView, shareIntegrations?: boolean): Promise<PageView | null> => {
      const before = queryClient.getQueryData<DashboardView>(draftKey) ?? dashboard;
      const op =
        view.kind === 'template'
          ? {
              op: 'add_view',
              templateKey: view.templateKey,
              ...(view.title === undefined ? {} : { title: view.title }),
            }
          : {
              op: 'add_view',
              type: view.type,
              ...(view.title === undefined ? {} : { title: view.title }),
              ...(view.config === undefined ? {} : { config: view.config }),
            };
      const after = await write([op], shareIntegrations);
      return after === null ? null : addedView(before, after);
    },
    [dashboard, draftKey, queryClient, write],
  );

  return {
    addView,
    renameView: async (viewId, title) =>
      (await write([{ op: 'update_view', viewId, title }])) !== null,
    moveView: async (viewId, index) => (await write([{ op: 'move_view', viewId, index }])) !== null,
    removeView: async (viewId) => (await write([{ op: 'remove_view', viewId }])) !== null,
    pending,
  };
}
