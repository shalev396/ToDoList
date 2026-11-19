import { AppError } from './AppError.js';

/**
 * 409 `not_deletable`: deleting a travel leg. TodoList makes legs from its member's day, so one is
 * skipped instead (a regeneration would only make it again).
 */
export class NotDeletableError extends AppError {
  constructor() {
    super(409, 'Travel is skipped, not deleted', { code: 'not_deletable' });
    this.name = 'NotDeletableError';
  }
}
