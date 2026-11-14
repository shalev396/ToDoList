/**
 * Switching workspaces (plan "Review focus 2"): after a switch nothing from the previous
 * workspace may remain, in the query cache, in open sheets and dialogs, or in drafts.
 *
 * - Every query that holds one workspace's data uses a key under `workspaceKey(wid, …)`.
 *   A switch drops all of them (the new workspace's too, so it loads fresh).
 *   Dashboards, block results, the builder catalog and views are all such keys.
 * - The workspace slice starts a new `generation`; the app shell keys its page outlet on it, so
 *   every page below remounts and loses its local state (sheets, dialogs, forms, shown-once links).
 *   Slices that hold drafts reset on the `workspaceSwitched` action (the dashboard editor's too).
 * - The user lands on the new workspace's dashboard, without the old page's URL variables.
 *
 * An implicit change (the current workspace left my list: I was removed, or it was deleted)
 * goes through the same applyWorkspaceChange as an explicit switch (reconcileWorkspace decides).
 */
import type { QueryClient } from '@tanstack/react-query';
import { pathTo, ROUTES } from '../../router/routes.ts';
import { workspaceSwitched } from '../../store/workspaceSlice.ts';

const WORKSPACE_SCOPE = 'ws';

/** `['ws', wid, ...rest]`: the key prefix of everything that belongs to one workspace. */
export function workspaceKey<const Rest extends readonly unknown[]>(
  workspaceId: string,
  ...rest: Rest
): readonly ['ws', string, ...Rest] {
  return [WORKSPACE_SCOPE, workspaceId, ...rest] as const;
}

export function isWorkspaceScopedKey(queryKey: readonly unknown[]): boolean {
  return queryKey[0] === WORKSPACE_SCOPE;
}

export interface WorkspaceSwitchInput {
  fromWorkspaceId: string | null;
  toWorkspaceId: string;
  language: string;
}

export interface WorkspaceSwitchPlan {
  /** False when the target is already the current workspace. */
  changed: boolean;
  /** True for every cached query to drop: all workspace data, account data stays. */
  removeQuery: (queryKey: readonly unknown[]) => boolean;
  /** Where the user lands. */
  navigateTo: string;
}

export function planWorkspaceSwitch({
  fromWorkspaceId,
  toWorkspaceId,
  language,
}: WorkspaceSwitchInput): WorkspaceSwitchPlan {
  return {
    changed: fromWorkspaceId !== toWorkspaceId,
    removeQuery: isWorkspaceScopedKey,
    navigateTo: pathTo(ROUTES.DASHBOARD, language),
  };
}

/** Cancels and drops every cached query the plan names, so none can land after the switch. */
export function dropWorkspaceQueries(queryClient: QueryClient, plan: WorkspaceSwitchPlan): void {
  const predicate = (query: { queryKey: readonly unknown[] }) => plan.removeQuery(query.queryKey);
  void queryClient.cancelQueries({ predicate });
  queryClient.removeQueries({ predicate });
}

const isScoped = (query: { queryKey: readonly unknown[] }) => isWorkspaceScopedKey(query.queryKey);

/**
 * The reset behind every workspace change: cancel in-flight fetches (a late answer must not
 * write the old workspace back), drop every workspace's cached data, then dispatch the
 * switch, which starts a new generation. Synchronous, so no render sees a half-done change.
 */
export function applyWorkspaceChange(
  queryClient: QueryClient,
  dispatch: (action: ReturnType<typeof workspaceSwitched>) => void,
  toWorkspaceId: string | null,
): void {
  void queryClient.cancelQueries({ predicate: isScoped });
  queryClient.removeQueries({ predicate: isScoped });
  dispatch(workspaceSwitched(toWorkspaceId));
}

export type WorkspaceReconciliation =
  | { kind: 'none' }
  /** No workspace was chosen yet (fresh sign-in): nothing of another one was shown. */
  | { kind: 'select'; workspaceId: string }
  /** The current workspace left my list: the full reset, to my oldest or to none. */
  | { kind: 'switch'; workspaceId: string | null };

/**
 * What to do about the current workspace once my list has settled. A list being refetched is
 * never used: it can predate a workspace I just created or joined.
 */
export function reconcileWorkspace({
  list,
  currentId,
  isFetching,
}: {
  /** My workspaces (only their ids matter here). */
  list: readonly { workspace: { id: string } }[] | undefined;
  currentId: string | null;
  isFetching: boolean;
}): WorkspaceReconciliation {
  if (list === undefined || isFetching) {
    return { kind: 'none' };
  }
  if (currentId !== null && list.some((entry) => entry.workspace.id === currentId)) {
    return { kind: 'none' };
  }
  const oldest = list[0]?.workspace.id ?? null;
  if (currentId === null) {
    return oldest === null ? { kind: 'none' } : { kind: 'select', workspaceId: oldest };
  }
  return { kind: 'switch', workspaceId: oldest };
}
