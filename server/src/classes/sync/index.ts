/**
 * The sync classes (docs/design/CLASSES.md §7): SyncRun (the state machine of one run), the
 * cursors (SyncCursor, a value object, and SyncCursors, SyncStates' only reader and writer) and
 * how a sync is asked for (SyncOptions). The engine behind Integration#sync (SyncEngine) and the
 * rows it writes (SyncedRows) are internal: not exported here (syncInternals.test.ts).
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
export type { RunClock, SyncOptions, SyncRunOptions } from './SyncOptions.js';
