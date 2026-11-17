/**
 * The dashboard editor's writes (FRONTEND.md §6), without React: layout changes, the layout save
 * with conflict recovery, removing a block, undo and redo. useDashboardEditor drives them (the
 * autosave timer, one write queue, toasts); the tests drive them with a real store and query
 * cache and a fake server.
 *
 * - Every write carries the version the previous one produced, so the editor's own writes never
 *   conflict with each other.
 * - A layout save is optimistic (FRONTEND.md §6): its positions go into the cached draft when it
 *   starts, so a move made while it is in flight is measured against them (even one back to where
 *   the block was), and they are taken back if it fails.
 * - A save answering 409 (an agent or another person changed the dashboard) refetches the draft
 *   and asks planConflictRecovery: re-apply what I moved (the save's and any newer moves) on the
 *   fresh version and save once more, or drop it with a toast. The grid always shows a whole
 *   layout (Review focus 5).
 * - The version edits are made against only ever becomes one the page has loaded: when the draft
 *   cannot be reloaded after a conflict or an undo, it stays, and the next save recovers.
 * - A write that finishes after a workspace switch touches nothing (Review focus 2).
 */
import type { QueryClient } from '@tanstack/react-query';
import type { UnknownAction } from '@reduxjs/toolkit';
import type { LayoutItem } from '@api-types/builder.ts';
import type { DashboardView } from '@api-types/dashboards.ts';
import { apiConflictVersion, apiErrorStatus } from '../../../api/errors.ts';
import { queryKeys } from '../../../api/queries/keys.ts';
import {
  blockRemoved,
  conflictDetected,
  conflictResolved,
  layoutChanged,
  pendingDropped,
  saveFailed,
  saveStarted,
  saveSucceeded,
  writeFailed,
  writeSucceeded,
  type EditorState,
} from '../../../store/editorSlice.ts';
import { BREAKPOINTS, type Breakpoint } from '../grid/constants.ts';
import {
  changedItems,
  mergeMoved,
  mergePending,
  plainLayout,
  revertPending,
  withPending,
  type MovedBlocks,
  type PendingLayouts,
} from '../grid/layouts.ts';
import { planConflictRecovery } from './conflict.ts';

/** The dashboard API the editor writes through (api/queries/dashboards.ts in the app). */
export interface EditorServer {
  getDraft: (signal: AbortSignal) => Promise<DashboardView>;
  saveLayout: (expectedVersion: number, layouts: PendingLayouts) => Promise<{ version: number }>;
  removeBlock: (expectedVersion: number, blockId: string) => Promise<{ version: number }>;
  undo: (expectedVersion: number) => Promise<{ version: number }>;
  redo: (expectedVersion: number) => Promise<{ version: number }>;
}

/** What the editor tells the user (a toast in the app). */
export type EditorNotice =
  | 'conflict'
  | 'saveFailed'
  | 'removeFailed'
  | 'changedElsewhere'
  | 'nothingToUndo'
  | 'nothingToRedo'
  | 'historyFailed';

export interface EditorStore {
  getState: () => { editor: EditorState; workspace: { generation: number } };
  dispatch: (action: UnknownAction) => unknown;
}

export interface EditorWritesInput {
  workspaceId: string;
  dashboardId: string;
  isOwner: boolean;
  store: EditorStore;
  queryClient: QueryClient;
  server: EditorServer;
  notify: (notice: EditorNotice) => void;
}

/** One layout save: the positions, the version they were made against, and when. */
export interface SaveJob {
  layouts: PendingLayouts;
  /** Of those, the blocks the user moved or resized (a conflict re-applies only these). */
  moved: MovedBlocks;
  baseVersion: number;
  /** The editor slice's revision then: a save overtaken by newer changes keeps those pending. */
  revision: number;
  /** The workspace generation then: nothing is written after a workspace switch. */
  generation: number;
}

export interface EditorWrites {
  /** A drag, resize or key left this layout on a breakpoint (stored left-to-right). */
  commit: (breakpoint: Breakpoint, layout: readonly LayoutItem[], moved: string | null) => void;
  /** What is pending now, if this dashboard is the one being edited. */
  capture: () => SaveJob | null;
  /** Saves what is pending, or `captured` (taken when the page was left). */
  savePending: (captured?: SaveJob) => Promise<void>;
  removeBlock: (blockId: string) => Promise<void>;
  history: (kind: 'undo' | 'redo') => Promise<void>;
}

function withoutBlock(
  view: DashboardView,
  blockId: string,
  version: number,
  isOwner: boolean,
): DashboardView {
  const layouts = { ...view.layouts };
  for (const breakpoint of BREAKPOINTS) {
    layouts[breakpoint] = view.layouts[breakpoint].filter((item) => item.i !== blockId);
  }
  return {
    ...view,
    blocks: view.blocks.filter((block) => block.id !== blockId),
    layouts,
    version,
    publishedVersion: isOwner ? version : view.publishedVersion,
  };
}

export function createEditorWrites({
  workspaceId,
  dashboardId,
  isOwner,
  store,
  queryClient,
  server,
  notify,
}: EditorWritesInput): EditorWrites {
  const { dispatch } = store;
  const draftKey = queryKeys.dashboard(workspaceId, dashboardId, 'draft');
  const generation = () => store.getState().workspace.generation;
  const isOpen = () => store.getState().editor.dashboardId === dashboardId;
  const cachedDraft = () => queryClient.getQueryData<DashboardView>(draftKey);
  /** The newest version one of these writes left in the cache. */
  let confirmedVersion = 0;
  const confirm = (version: number) => {
    confirmedVersion = Math.max(confirmedVersion, version);
  };

  /** The draft from the server, into the cache (what the page shows). */
  const fetchDraft = () =>
    queryClient.fetchQuery({
      queryKey: draftKey,
      staleTime: 0,
      queryFn: ({ signal }) => server.getDraft(signal),
    });

  /** History, lists and the published copy moved on; the history is shown, so it reloads. */
  const afterWrite = () => {
    void queryClient.invalidateQueries({
      queryKey: queryKeys.dashboardVersions(workspaceId, dashboardId),
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.dashboards(workspaceId),
      refetchType: 'none',
    });
    void queryClient.invalidateQueries({
      queryKey: queryKeys.dashboard(workspaceId, dashboardId, 'published'),
      refetchType: 'none',
    });
  };

  /** The cached draft with saved positions: an owner's save is also what viewers see. */
  const markSaved = (layouts: PendingLayouts, version: number) => {
    confirm(version);
    queryClient.setQueryData<DashboardView>(draftKey, (view) =>
      view === undefined
        ? view
        : {
            ...view,
            version,
            publishedVersion: isOwner ? version : view.publishedVersion,
            layouts: withPending(view.layouts, layouts),
          },
    );
    afterWrite();
  };

  /**
   * Shows `layouts` in the cached draft at once, before the server answers. Returns how to take
   * them back (only where they still hold) if the save fails.
   */
  const showOptimistically = (layouts: PendingLayouts): (() => void) => {
    const before = cachedDraft();
    if (before === undefined) {
      return () => undefined;
    }
    queryClient.setQueryData<DashboardView>(draftKey, {
      ...before,
      layouts: withPending(before.layouts, layouts),
    });
    return () => {
      queryClient.setQueryData<DashboardView>(draftKey, (view) =>
        view === undefined
          ? view
          : { ...view, layouts: revertPending(view.layouts, layouts, before.layouts) },
      );
    };
  };

  /** Measured against the cached draft: saved positions plus a save in flight. */
  const commit = (breakpoint: Breakpoint, layout: readonly LayoutItem[], moved: string | null) => {
    const view = cachedDraft();
    if (view === undefined) {
      return;
    }
    const items = changedItems(plainLayout(layout), view.layouts[breakpoint]);
    dispatch(layoutChanged({ dashboardId, breakpoint, items, moved }));
  };

  /**
   * After a 409: re-apply on the fresh version, or drop the change (planConflictRecovery). What
   * I meant is `job` with any change made since on top; `takeBack` undoes its optimistic positions.
   */
  const recover = async (
    job: SaveJob,
    currentVersion: number,
    startedIn: number,
    takeBack: () => void,
  ): Promise<void> => {
    dispatch(conflictDetected({ currentVersion }));
    /** `version`: the fresh draft's, once loaded; null keeps the version last loaded. */
    const dropChange = (version: number | null) => {
      dispatch(pendingDropped());
      dispatch(conflictResolved({ version }));
      notify('conflict');
    };
    let fresh: DashboardView;
    try {
      fresh = await fetchDraft();
    } catch {
      if (generation() !== startedIn) {
        return;
      }
      takeBack();
      if (isOpen()) {
        dropChange(null);
      }
      return;
    }
    if (generation() !== startedIn || !isOpen()) {
      return;
    }
    const state = store.getState().editor;
    const plan = planConflictRecovery(
      {
        layouts: mergePending(job.layouts, state.pendingLayout),
        moved: mergeMoved(job.moved, state.movedBlocks),
      },
      fresh,
    );
    if (plan.kind === 'drop') {
      dropChange(fresh.version);
      return;
    }
    if (plan.kind === 'resolved') {
      dispatch(pendingDropped());
      dispatch(conflictResolved({ version: fresh.version }));
      return;
    }
    const { revision } = state;
    const takePlanBack = showOptimistically(plan.layouts);
    try {
      const saved = await server.saveLayout(plan.expectedVersion, plan.layouts);
      if (generation() !== startedIn) {
        return;
      }
      markSaved(plan.layouts, saved.version);
      if (isOpen()) {
        dispatch(saveSucceeded({ version: saved.version, revision }));
      }
    } catch {
      if (generation() !== startedIn) {
        return;
      }
      takePlanBack();
      const newest = await fetchDraft().catch(() => null);
      if (isOpen()) {
        dropChange(newest?.version ?? fresh.version);
      }
    }
  };

  const capture = (): SaveJob | null => {
    const state = store.getState().editor;
    if (!isOpen() || state.pendingLayout === null || state.baseVersion === null) {
      return null;
    }
    return {
      layouts: state.pendingLayout,
      moved: state.movedBlocks ?? {},
      baseVersion: state.baseVersion,
      revision: state.revision,
      generation: generation(),
    };
  };

  const savePending = async (captured?: SaveJob): Promise<void> => {
    const job = captured ?? capture();
    if (job?.generation !== generation()) {
      return;
    }
    const startedIn = job.generation;
    if (isOpen()) {
      dispatch(saveStarted());
    }
    const takeBack = showOptimistically(job.layouts);
    // A job taken when the page was left may predate a save that was in flight then: it was
    // measured against that save's positions, so it goes on from the version that save made.
    const expectedVersion = Math.max(job.baseVersion, confirmedVersion);
    try {
      const saved = await server.saveLayout(expectedVersion, job.layouts);
      if (generation() !== startedIn) {
        return;
      }
      markSaved(job.layouts, saved.version);
      if (isOpen()) {
        dispatch(saveSucceeded({ version: saved.version, revision: job.revision }));
      }
    } catch (error) {
      if (generation() !== startedIn) {
        return;
      }
      const currentVersion = apiConflictVersion(error);
      if (isOpen() && currentVersion !== null) {
        await recover(job, currentVersion, startedIn, takeBack);
        return;
      }
      takeBack();
      if (isOpen()) {
        dispatch(saveFailed());
      }
      notify(currentVersion === null ? 'saveFailed' : 'conflict');
      void fetchDraft().catch(() => undefined);
    }
  };

  const removeBlock = async (blockId: string): Promise<void> => {
    const startedIn = generation();
    const state = store.getState().editor;
    if (!isOpen() || state.baseVersion === null) {
      return;
    }
    dispatch(saveStarted());
    try {
      let version: number;
      try {
        version = (await server.removeBlock(state.baseVersion, blockId)).version;
      } catch (error) {
        if (apiConflictVersion(error) === null || generation() !== startedIn) {
          throw error;
        }
        // Changed meanwhile: remove it from the fresh version, if it is still there.
        const fresh = await fetchDraft();
        if (!fresh.blocks.some((block) => block.id === blockId)) {
          confirm(fresh.version);
          if (isOpen()) {
            dispatch(blockRemoved({ blockId }));
            dispatch(writeSucceeded({ version: fresh.version }));
          }
          return;
        }
        version = (await server.removeBlock(fresh.version, blockId)).version;
      }
      if (generation() !== startedIn) {
        return;
      }
      queryClient.setQueryData<DashboardView>(draftKey, (view) =>
        view === undefined ? view : withoutBlock(view, blockId, version, isOwner),
      );
      confirm(version);
      afterWrite();
      if (isOpen()) {
        dispatch(blockRemoved({ blockId }));
        dispatch(writeSucceeded({ version }));
      }
    } catch {
      if (generation() !== startedIn) {
        return;
      }
      if (isOpen()) {
        dispatch(writeFailed());
      }
      notify('removeFailed');
      void fetchDraft().catch(() => undefined);
    }
  };

  /** Undo or redo on the server, then the cache becomes what they left. */
  const history = async (kind: 'undo' | 'redo'): Promise<void> => {
    const startedIn = generation();
    const state = store.getState().editor;
    if (!isOpen() || state.baseVersion === null) {
      return;
    }
    dispatch(saveStarted());
    try {
      const write = kind === 'undo' ? server.undo : server.redo;
      await write(state.baseVersion);
      if (generation() !== startedIn) {
        return;
      }
      const fresh = await fetchDraft().catch(() => null);
      // Block settings may have changed back too.
      void queryClient.invalidateQueries({
        queryKey: queryKeys.dashboardBlocks(workspaceId, dashboardId),
      });
      afterWrite();
      // Not reloaded: the version stays the one the page shows (the next save recovers).
      if (fresh !== null) {
        confirm(fresh.version);
      }
      if (isOpen()) {
        dispatch(writeSucceeded({ version: fresh?.version ?? null }));
      }
    } catch (error) {
      if (generation() !== startedIn) {
        return;
      }
      if (isOpen()) {
        dispatch(writeFailed());
      }
      if (apiConflictVersion(error) !== null) {
        void fetchDraft().catch(() => undefined);
        notify('changedElsewhere');
      } else if (apiErrorStatus(error) === 409) {
        notify(kind === 'undo' ? 'nothingToUndo' : 'nothingToRedo');
        afterWrite();
      } else {
        notify('historyFailed');
      }
    }
  };

  return {
    commit,
    capture,
    savePending,
    removeBlock,
    history,
  };
}
