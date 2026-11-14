/**
 * The dashboard editor's draft (FRONTEND.md §6): the version edits are made against, the block
 * positions changed since the last save, and the save in flight. Layout changes are debounced and
 * saved by features/dashboards/editor/useDashboardEditor.ts, which drives these actions.
 *
 * Reset on a workspace switch and on sign-out (plan "Review focus 2"), together with the query
 * cache (features/workspaces/switching.ts) and the remounted pages: no draft of one workspace
 * survives into another.
 */
import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction, UnknownAction } from '@reduxjs/toolkit';
import type { LayoutItem } from '@api-types/builder.ts';
import { BREAKPOINTS, type Breakpoint } from '../features/dashboards/grid/constants.ts';
import type { MovedBlocks, PendingLayouts } from '../features/dashboards/grid/layouts.ts';
import { LOGOUT_ACTION_TYPE, workspaceSwitched } from './workspaceSlice.ts';

export interface EditorState {
  /** The dashboard being edited. */
  dashboardId: string | null;
  /** The draft version the next write carries as `expectedVersion`. */
  baseVersion: number | null;
  /** Positions changed since the last save: only the blocks that moved, per breakpoint. */
  pendingLayout: PendingLayouts | null;
  /**
   * Of those, the blocks the user moved or resized; the rest were pushed by them. A conflict
   * re-applies only these (features/dashboards/editor/conflict.ts).
   */
  movedBlocks: MovedBlocks | null;
  /** Counts layout changes, so a finished save knows whether newer ones came in meanwhile. */
  revision: number;
  /** A write is in flight (or a conflict is being recovered). */
  saving: boolean;
  /** A save answered 409; set while the editor refetches and re-applies or drops the change. */
  conflict: { currentVersion: number } | null;
  /** A save finished in this session (the header says "Saved"). */
  saved: boolean;
}

export const initialEditorState: EditorState = {
  dashboardId: null,
  baseVersion: null,
  pendingLayout: null,
  movedBlocks: null,
  revision: 0,
  saving: false,
  conflict: null,
  saved: false,
};

/** Each breakpoint's entries that `keep` accepts; null when none are left. */
function filterEach<T>(
  per: Partial<Record<Breakpoint, T[]>>,
  keep: (entry: T, breakpoint: Breakpoint) => boolean,
): Partial<Record<Breakpoint, T[]>> | null {
  const next: Partial<Record<Breakpoint, T[]>> = {};
  for (const breakpoint of BREAKPOINTS) {
    const entries = per[breakpoint]?.filter((entry) => keep(entry, breakpoint));
    if (entries !== undefined && entries.length > 0) {
      next[breakpoint] = entries;
    }
  }
  return Object.keys(next).length === 0 ? null : next;
}

const editorSlice = createSlice({
  name: 'editor',
  initialState: initialEditorState,
  reducers: {
    /**
     * A dashboard is shown at `version`. Another dashboard starts over; the same one follows a
     * newer version (a refetch) unless a change is pending or being saved against the old one.
     */
    editorOpened: (state, action: PayloadAction<{ dashboardId: string; version: number }>) => {
      const { dashboardId, version } = action.payload;
      if (state.dashboardId !== dashboardId) {
        return { ...initialEditorState, dashboardId, baseVersion: version };
      }
      if (state.pendingLayout === null && !state.saving) {
        state.baseVersion = version;
      }
      return undefined;
    },
    /**
     * The blocks of one breakpoint that now differ from the saved layout (none: all saved), after
     * the user moved or resized `moved` (null: not known).
     */
    layoutChanged: (
      state,
      action: PayloadAction<{
        dashboardId: string;
        breakpoint: Breakpoint;
        items: LayoutItem[];
        moved: string | null;
      }>,
    ) => {
      const { dashboardId, breakpoint, items, moved } = action.payload;
      if (state.dashboardId !== dashboardId) {
        return;
      }
      const pending = filterEach({ ...state.pendingLayout, [breakpoint]: items }, () => true);
      const before = state.movedBlocks?.[breakpoint] ?? [];
      const movedHere = moved === null || before.includes(moved) ? before : [...before, moved];
      // Only blocks still pending count as moved.
      state.movedBlocks = filterEach(
        { ...state.movedBlocks, [breakpoint]: movedHere },
        (id, each) => (pending?.[each] ?? []).some((item) => item.i === id),
      );
      state.pendingLayout = pending;
      state.revision += 1;
      state.saved = false;
    },
    saveStarted: (state) => {
      state.saving = true;
    },
    /** Saved as `version`; the change is cleared unless a newer one (`revision`) came in. */
    saveSucceeded: (state, action: PayloadAction<{ version: number; revision: number }>) => {
      state.baseVersion = action.payload.version;
      state.saving = false;
      state.conflict = null;
      state.saved = true;
      if (state.revision === action.payload.revision) {
        state.pendingLayout = null;
        state.movedBlocks = null;
      }
    },
    /** Not saved: the change is dropped, so the page shows the saved layout again. */
    saveFailed: (state) => {
      state.saving = false;
      state.conflict = null;
      state.pendingLayout = null;
      state.movedBlocks = null;
    },
    conflictDetected: (state, action: PayloadAction<{ currentVersion: number }>) => {
      state.conflict = { currentVersion: action.payload.currentVersion };
      state.saving = true;
    },
    /**
     * Recovery finished at `version` (re-applied and saved, dropped, or nothing to do). Null: the
     * fresh draft could not be loaded, so edits stay against the version last loaded (the next
     * save conflicts and recovers again); never a version the page has not shown.
     */
    conflictResolved: (state, action: PayloadAction<{ version: number | null }>) => {
      state.conflict = null;
      state.saving = false;
      if (action.payload.version !== null) {
        state.baseVersion = action.payload.version;
      }
    },
    /**
     * A write other than a layout save (undo, redo, remove) made the draft `version`. Null: done,
     * but what it made could not be loaded; the version last loaded stays, as above.
     */
    writeSucceeded: (state, action: PayloadAction<{ version: number | null }>) => {
      if (action.payload.version !== null) {
        state.baseVersion = action.payload.version;
      }
      state.saving = false;
      state.saved = true;
    },
    /** A write other than a layout save failed; pending positions stay for their own save. */
    writeFailed: (state) => {
      state.saving = false;
    },
    pendingDropped: (state) => {
      state.pendingLayout = null;
      state.movedBlocks = null;
    },
    blockRemoved: (state, action: PayloadAction<{ blockId: string }>) => {
      const { blockId } = action.payload;
      state.pendingLayout = filterEach(state.pendingLayout ?? {}, (item) => item.i !== blockId);
      state.movedBlocks = filterEach(state.movedBlocks ?? {}, (id) => id !== blockId);
    },
    editorClosed: () => initialEditorState,
  },
  extraReducers: (builder) => {
    builder.addCase(workspaceSwitched, () => initialEditorState);
    // userSlice's logout, matched by type as workspaceSlice does.
    builder.addMatcher(
      (action: UnknownAction) => action.type === LOGOUT_ACTION_TYPE,
      () => initialEditorState,
    );
  },
});

export const {
  editorOpened,
  layoutChanged,
  saveStarted,
  saveSucceeded,
  saveFailed,
  conflictDetected,
  conflictResolved,
  writeSucceeded,
  writeFailed,
  pendingDropped,
  blockRemoved,
  editorClosed,
} = editorSlice.actions;

interface StateWithEditor {
  editor: EditorState;
}

export const selectEditor = (state: StateWithEditor) => state.editor;

export default editorSlice.reducer;
