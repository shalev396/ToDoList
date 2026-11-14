import { useCallback, useEffect, useMemo, useRef } from 'react';
import { useDispatch, useSelector, useStore } from 'react-redux';
import { useQueryClient } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { toast } from 'sonner';
import type { LayoutItem, Layouts } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';
import {
  useApplyDashboardOps,
  useDashboardVersions,
  useRedoDashboard,
  useUndoDashboard,
  useUpdateDashboardLayout,
} from '@/api/queries/dashboards';
import { getDashboard } from '@/api/services/dashboardService';
import type { AppDispatch, RootState } from '@/store';
import { editorOpened, selectEditor } from '@/store/editorSlice';
import type { Breakpoint } from '../grid/constants';
import { withPending } from '../grid/layouts';
import { createEditorWrites, type EditorNotice, type EditorServer } from './editorWrites';
import { historyAvailability } from './history';

/** Layout changes are saved this long after the last one (one save per burst of moves). */
export const AUTOSAVE_DELAY_MS = 800;

export type EditorStatus = 'idle' | 'saving' | 'saved';

export interface DashboardEditor {
  /** The stored layouts with the changes not saved yet on top: what the grid shows. */
  layouts: Layouts;
  /**
   * A drag, resize or key left this layout on a breakpoint (stored left-to-right); `moved` is the
   * block the user moved or resized (the others were pushed by it).
   */
  commitLayout: (
    breakpoint: Breakpoint,
    layout: readonly LayoutItem[],
    moved: string | null,
  ) => void;
  /** `remove_block`, after any pending save. */
  removeBlock: (blockId: string) => void;
  undo: () => void;
  redo: () => void;
  /** Saves pending changes now (Done, leaving the page). */
  flush: () => void;
  status: EditorStatus;
  /** A change is waiting or a write is in flight: Undo and Redo wait. */
  busy: boolean;
  canUndo: boolean;
  canRedo: boolean;
}

interface DashboardEditorInput {
  workspaceId: string;
  /** The cached draft. */
  dashboard: DashboardView;
  isOwner: boolean;
  /** An editor or owner on the draft: the only case anything is written. */
  active: boolean;
  /** Edit mode is on. */
  editing: boolean;
}

const NOTICE_KEYS: Readonly<Record<EditorNotice, string>> = {
  conflict: 'dashboard.conflict',
  saveFailed: 'dashboard.saveFailed',
  removeFailed: 'dashboard.grid.removeFailed',
  changedElsewhere: 'dashboard.changedElsewhere',
  nothingToUndo: 'dashboard.nothingToUndo',
  nothingToRedo: 'dashboard.nothingToRedo',
  historyFailed: 'dashboard.historyFailed',
};

/**
 * The dashboard editor (FRONTEND.md §6): debounced layout autosave, undo, redo and removing a
 * block, with the draft in the editor slice and the dashboard in the query cache. The writes and
 * their rules are editorWrites.ts; this hook gives them the store, the cache, the API and toasts,
 * runs them in one queue, and saves 800ms after the last change.
 */
export function useDashboardEditor({
  workspaceId,
  dashboard,
  isOwner,
  active,
  editing,
}: DashboardEditorInput): DashboardEditor {
  const { t } = useTranslation();
  const dispatch = useDispatch<AppDispatch>();
  const store = useStore<RootState>();
  const queryClient = useQueryClient();
  const editor = useSelector(selectEditor);
  const dashboardId = dashboard.id;

  const saveLayout = useUpdateDashboardLayout(workspaceId, dashboardId).mutateAsync;
  const applyOps = useApplyDashboardOps(workspaceId, dashboardId).mutateAsync;
  const undoWrite = useUndoDashboard(workspaceId, dashboardId).mutateAsync;
  const redoWrite = useRedoDashboard(workspaceId, dashboardId).mutateAsync;
  const versions = useDashboardVersions(workspaceId, dashboardId, active && editing);

  useEffect(() => {
    if (active) {
      dispatch(editorOpened({ dashboardId, version: dashboard.version }));
    }
  }, [active, dashboardId, dashboard.version, dispatch]);

  const queue = useRef<Promise<void>>(Promise.resolve());
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  const enqueue = useCallback((task: () => Promise<void>) => {
    queue.current = queue.current.then(task).catch((error: unknown) => {
      console.error('[dashboard] a write failed unexpectedly', error);
    });
  }, []);

  const writes = useMemo(() => {
    const server: EditorServer = {
      getDraft: async (signal) => {
        const response = await getDashboard(workspaceId, dashboardId, 'draft', {
          signal,
          suppressErrorToast: true,
        });
        return response.data;
      },
      saveLayout: (expectedVersion, layouts) => saveLayout({ expectedVersion, layouts }),
      removeBlock: async (expectedVersion, blockId) => {
        const result = await applyOps({ expectedVersion, ops: [{ op: 'remove_block', blockId }] });
        if (!('version' in result)) {
          throw new Error('A write answered like a dry run');
        }
        return result;
      },
      undo: (expectedVersion) => undoWrite({ expectedVersion }),
      redo: (expectedVersion) => redoWrite({ expectedVersion }),
    };
    return createEditorWrites({
      workspaceId,
      dashboardId,
      isOwner,
      store,
      queryClient,
      server,
      notify: (notice) => {
        toast.error(t(NOTICE_KEYS[notice]));
      },
    });
  }, [
    workspaceId,
    dashboardId,
    isOwner,
    store,
    queryClient,
    t,
    saveLayout,
    applyOps,
    undoWrite,
    redoWrite,
  ]);

  const flush = useCallback(() => {
    if (timer.current !== null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
    enqueue(() => writes.savePending());
  }, [enqueue, writes]);

  const commitLayout = useCallback(
    (breakpoint: Breakpoint, layout: readonly LayoutItem[], moved: string | null) => {
      if (!active) {
        return;
      }
      writes.commit(breakpoint, layout, moved);
      if (timer.current !== null) {
        clearTimeout(timer.current);
      }
      timer.current = setTimeout(() => {
        timer.current = null;
        enqueue(() => writes.savePending());
      }, AUTOSAVE_DELAY_MS);
    },
    [active, enqueue, writes],
  );

  const removeBlock = useCallback(
    (blockId: string) => {
      flush();
      enqueue(() => writes.removeBlock(blockId));
    },
    [flush, enqueue, writes],
  );
  const undo = useCallback(() => {
    enqueue(() => writes.history('undo'));
  }, [enqueue, writes]);
  const redo = useCallback(() => {
    enqueue(() => writes.history('redo'));
  }, [enqueue, writes]);

  // Leaving edit mode saves what is pending at once.
  const flushRef = useRef(flush);
  const writesRef = useRef(writes);
  useEffect(() => {
    flushRef.current = flush;
    writesRef.current = writes;
  }, [flush, writes]);
  useEffect(() => {
    if (!editing) {
      flushRef.current();
    }
  }, [editing]);
  // Leaving the page too, with what is pending taken now: the next dashboard's editor may open
  // before the save runs. A workspace switch has already reset the draft by then, so
  // nothing of the old workspace is written.
  useEffect(
    () => () => {
      if (timer.current !== null) {
        clearTimeout(timer.current);
        timer.current = null;
      }
      const job = writesRef.current.capture();
      if (job !== null) {
        enqueue(() => writesRef.current.savePending(job));
      }
    },
    [enqueue],
  );

  const open = editor.dashboardId === dashboardId;
  const pending = open ? editor.pendingLayout : null;
  const layouts = useMemo(
    () => withPending(dashboard.layouts, pending),
    [dashboard.layouts, pending],
  );
  const busy = open && (editor.saving || editor.pendingLayout !== null);
  const availability = historyAvailability(versions.data ?? []);

  return {
    layouts,
    commitLayout,
    removeBlock,
    undo,
    redo,
    flush,
    status: busy ? 'saving' : open && editor.saved ? 'saved' : 'idle',
    busy,
    canUndo: active && !busy && availability.canUndo,
    canRedo: active && !busy && availability.canRedo,
  };
}
