import { useEffect } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { useWorkspaces } from '@/api/queries/workspaces';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { applyWorkspaceChange, reconcileWorkspace } from '@/features/workspaces/switching';
import { selectCurrentWorkspaceId, workspaceSelected } from '@/store/workspaceSlice';
import type { AppDispatch } from '@/store';

/**
 * Keeps the current workspace one of mine (Review focus 2). Mounted once per layout of the
 * signed-in app. When the list settles without it (I was removed, or it was deleted) this runs
 * the same reset as an explicit switch: in-flight fetches cancelled, every workspace's data
 * dropped, the pages remounted (their dialogs close), and the dashboard of my oldest workspace,
 * or onboarding when none is left. A first selection after sign-in only records the choice.
 */
export function useWorkspaceReconciler(): void {
  const dispatch = useDispatch<AppDispatch>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const currentId = useSelector(selectCurrentWorkspaceId);
  const { data, isFetching } = useWorkspaces();
  const step = reconcileWorkspace({ list: data, currentId, isFetching });
  const target = step.kind === 'none' ? undefined : step.workspaceId;

  useEffect(() => {
    if (step.kind === 'select' && target !== undefined && target !== null) {
      dispatch(workspaceSelected(target));
    } else if (step.kind === 'switch' && target !== undefined) {
      applyWorkspaceChange(queryClient, dispatch, target);
      void navigate(pathTo(target === null ? ROUTES.ONBOARDING : ROUTES.DASHBOARD, language));
    }
  }, [step.kind, target, dispatch, queryClient, navigate, language]);
}
