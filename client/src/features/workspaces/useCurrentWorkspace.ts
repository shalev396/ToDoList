import { useCallback, useMemo } from 'react';
import { useSelector } from 'react-redux';
import { useWorkspaces } from '@/api/queries/workspaces';
import { useTopics } from '@/api/queries/topics';
import { selectCurrentWorkspaceId } from '@/store/workspaceSlice';
import { sortTopics } from '@/features/workspaces/topics';
import type { Role } from '@api-types/domain';
import type { MyWorkspaceView, TopicView, WorkspaceView } from '@api-types/api-contracts';

export interface CurrentWorkspace {
  /**
   * The workspace the app shows: the current one while it is in my list. Null while loading,
   * without any workspace, and while a change settles (`isSettling`).
   */
  workspace: WorkspaceView | null;
  role: Role | null;
  settings: WorkspaceView['settings'] | null;
  /** The workspace's topics (its pages), in sidebar order: every member sees all of them. */
  topics: TopicView[];
  /** The topics are still loading (the list is empty until they arrive). */
  topicsLoading: boolean;
  isOwner: boolean;
  /** All my workspaces. */
  workspaces: MyWorkspaceView[];
  isLoading: boolean;
  isError: boolean;
  /**
   * I have workspaces but none is current yet: the reconciler (useWorkspaceReconciler) is
   * selecting one, or resetting after the current one left my list. Show a skeleton, not
   * onboarding and not another workspace's data.
   */
  isSettling: boolean;
  refetch: () => void;
}

const NONE: MyWorkspaceView[] = [];
const NO_TOPICS: TopicView[] = [];

/** The current workspace, derived only: useWorkspaceReconciler makes the changes. */
export function useCurrentWorkspace(): CurrentWorkspace {
  const currentId = useSelector(selectCurrentWorkspaceId);
  const { data, isLoading, isError, refetch } = useWorkspaces();
  const workspaces = data ?? NONE;
  const current = useMemo(
    () => workspaces.find((entry) => entry.workspace.id === currentId) ?? null,
    [workspaces, currentId],
  );
  const topicsQuery = useTopics(current?.workspace.id ?? null);
  const topics = useMemo(
    () => (topicsQuery.data === undefined ? NO_TOPICS : sortTopics(topicsQuery.data)),
    [topicsQuery.data],
  );
  const retry = useCallback(() => {
    void refetch();
  }, [refetch]);

  return {
    workspace: current?.workspace ?? null,
    role: current?.role ?? null,
    settings: current?.workspace.settings ?? null,
    topics,
    topicsLoading: current !== null && topicsQuery.isPending,
    isOwner: current?.role === 'owner',
    workspaces,
    isLoading,
    isError,
    isSettling: current === null && workspaces.length > 0,
    refetch: retry,
  };
}
