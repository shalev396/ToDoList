import { createSlice } from '@reduxjs/toolkit';
import type { PayloadAction, UnknownAction } from '@reduxjs/toolkit';

/** localStorage key of the workspace the app opens; written by store/index.ts. */
export const CURRENT_WORKSPACE_STORAGE_KEY = 'todolist-current-workspace';

/** The type of userSlice's `logout` action (`user/logout`). */
export const LOGOUT_ACTION_TYPE = 'user/logout';

export interface WorkspaceState {
  /** The workspace the app shows. Checked against my workspaces by useCurrentWorkspace. */
  currentWorkspaceId: string | null;
  /**
   * Starts again at every switch (and sign-out). The app shell keys its pages on it, so a switch
   * remounts them and nothing from the previous workspace stays on screen
   * (features/workspaces/switching.ts).
   */
  generation: number;
}

/** Storage may be missing (tests, SSR) or throw (private mode); then nothing is remembered. */
function readStoredWorkspaceId(): string | null {
  try {
    return typeof localStorage === 'undefined'
      ? null
      : localStorage.getItem(CURRENT_WORKSPACE_STORAGE_KEY);
  } catch {
    return null;
  }
}

const initialState: WorkspaceState = {
  currentWorkspaceId: readStoredWorkspaceId(),
  generation: 0,
};

const workspaceSlice = createSlice({
  name: 'workspace',
  initialState,
  reducers: {
    /** The user switched workspaces: a new generation, so every page remounts. */
    workspaceSwitched: (state, action: PayloadAction<string | null>) => {
      if (state.currentWorkspaceId === action.payload) {
        return;
      }
      state.currentWorkspaceId = action.payload;
      state.generation += 1;
    },
    /**
     * The workspace to open was decided without a switch: at sign-in (the server's default) or
     * when the remembered one is no longer mine. Nothing of another workspace was shown yet.
     */
    workspaceSelected: (state, action: PayloadAction<string | null>) => {
      state.currentWorkspaceId = action.payload;
    },
  },
  extraReducers: (builder) => {
    // userSlice's logout, matched by type so this slice (and its unit test) needs no DOM code.
    builder.addMatcher(
      (action: UnknownAction) => action.type === LOGOUT_ACTION_TYPE,
      (state) => {
        state.currentWorkspaceId = null;
        state.generation += 1;
      },
    );
  },
});

export const { workspaceSwitched, workspaceSelected } = workspaceSlice.actions;

interface StateWithWorkspace {
  workspace: WorkspaceState;
}

export const selectCurrentWorkspaceId = (state: StateWithWorkspace) =>
  state.workspace.currentWorkspaceId;
export const selectWorkspaceGeneration = (state: StateWithWorkspace) => state.workspace.generation;

export default workspaceSlice.reducer;
