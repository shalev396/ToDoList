import type { CleanupProgress } from '../types/primaryCalendar.js';
import { AppError } from './AppError.js';

export type { CleanupProgress };

/**
 * 409 `cleanup_incomplete`: removing what TodoList added at a calendar ran out of its time budget.
 * What was done stays done (deleted, tombstoned); calling again goes on from there. `progress`
 * reaches the client (controllers answer `{message, code, progress}`); nothing is disconnected
 * while it is incomplete.
 */
export class CleanupIncompleteError extends AppError {
  readonly progress: Readonly<CleanupProgress>;

  constructor(progress: CleanupProgress) {
    super(409, 'Not everything TodoList added could be removed yet: continue to remove the rest', {
      code: 'cleanup_incomplete',
    });
    this.name = 'CleanupIncompleteError';
    this.progress = Object.freeze({ ...progress });
  }
}
