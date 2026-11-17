import { useCallback } from 'react';
import { useDispatch, useSelector } from 'react-redux';
import { useNavigate } from 'react-router-dom';
import { useQueryClient } from '@tanstack/react-query';
import { setDefaultWorkspace } from '@/api/services/workspaceService';
import { useLanguage } from '@/hooks/useLanguage';
import { applyWorkspaceChange, planWorkspaceSwitch } from '@/features/workspaces/switching';
import { selectCurrentWorkspaceId } from '@/store/workspaceSlice';
import type { AppDispatch } from '@/store';

export interface SwitchOptions {
  /**
   * Remember it on the server for the next sign-in (PUT /me/default-workspace). Off when the
   * server already made it the default (a new workspace).
   */
  remember?: boolean;
  /** Go to its dashboard (default). Off for callers that navigate themselves. */
  navigate?: boolean;
}

/**
 * Switches workspaces through applyWorkspaceChange (switching.ts): in-flight fetches are
 * cancelled, every workspace's cached data is dropped, the pages remount, and the user lands
 * on the new dashboard. All of it in one tick, so no page renders old data with the new id.
 */
export function useSwitchWorkspace() {
  const dispatch = useDispatch<AppDispatch>();
  const queryClient = useQueryClient();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const currentId = useSelector(selectCurrentWorkspaceId);

  return useCallback(
    (workspaceId: string, options: SwitchOptions = {}) => {
      const plan = planWorkspaceSwitch({
        fromWorkspaceId: currentId,
        toWorkspaceId: workspaceId,
        language,
      });
      if (plan.changed) {
        applyWorkspaceChange(queryClient, dispatch, workspaceId);
      }
      if (options.remember !== false) {
        // The interceptor reports a failure; the switch itself stands either way.
        setDefaultWorkspace({ workspaceId }).catch(() => undefined);
      }
      if (options.navigate !== false) {
        void navigate(plan.navigateTo);
      }
    },
    [currentId, language, queryClient, dispatch, navigate],
  );
}
