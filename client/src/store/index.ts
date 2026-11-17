import { configureStore } from '@reduxjs/toolkit';
import userReducer from './userSlice';
import editorReducer from './editorSlice';
import workspaceReducer, { CURRENT_WORKSPACE_STORAGE_KEY } from './workspaceSlice';

export const store = configureStore({
  reducer: {
    user: userReducer,
    workspace: workspaceReducer,
    editor: editorReducer,
  },
});

export type RootState = ReturnType<typeof store.getState>;
export type AppDispatch = typeof store.dispatch;

// The current workspace survives reloads and new tabs. Written here rather than in the
// reducers, so they stay pure (and unit-testable); storage errors (private mode) are ignored.
let storedWorkspaceId = store.getState().workspace.currentWorkspaceId;
store.subscribe(() => {
  const next = store.getState().workspace.currentWorkspaceId;
  if (next === storedWorkspaceId) {
    return;
  }
  storedWorkspaceId = next;
  try {
    if (next === null) {
      localStorage.removeItem(CURRENT_WORKSPACE_STORAGE_KEY);
    } else {
      localStorage.setItem(CURRENT_WORKSPACE_STORAGE_KEY, next);
    }
  } catch {
    /* ignore */
  }
});
