import { AppError } from './AppError.js';

/**
 * 409 `not_completable`: completing an item that has no status to complete. A time block, an area
 * and a travel leg are reserved time (ScheduledItem), not markable to-dos.
 */
export class NotCompletableError extends AppError {
  constructor() {
    super(409, 'A time block or travel has no status', { code: 'not_completable' });
    this.name = 'NotCompletableError';
  }
}
