/**
 * The sync classes (docs/design/CLASSES.md §6): SyncRun (the state machine of one run), the
 * cursors (SyncCursor, a value object, and SyncCursors, SyncStates' only reader and writer) and
 * the engine behind Integration#sync (SyncEngine).
 */
export {
  IllegalSyncRunTransitionError,
  SYNC_ERROR_MESSAGES,
  SYNC_RUN_TRANSITIONS,
  SyncRun,
  type SyncRequestTarget,
  type SyncRunOwner,
  type SyncRunResults,
  type SyncRunTransition,
} from './SyncRun.js';
export { SyncCursor } from './SyncCursor.js';
export { SyncCursors } from './SyncCursors.js';
export {
  FAILED_RUNS_BEFORE_ERROR,
  FULL_SYNC_INTERVAL_MS,
  MAX_RECORDED_FAILURES,
  SyncEngine,
  type RunClock,
  type SyncOptions,
  type SyncRunOptions,
  type SyncTarget,
} from './SyncEngine.js';
