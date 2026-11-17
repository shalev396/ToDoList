import { AppError } from './AppError.js';

/**
 * 409 `primary_calendar_unset`: a recurring to-do is created in the workspace's primary calendar
 * only (plan Addendum A3), and the workspace has none, or the integration it was on is gone. A
 * workspace owner chooses one; nothing was sent.
 */
export class PrimaryCalendarUnsetError extends AppError {
  constructor() {
    super(409, 'Recurring to-dos are created in the workspace calendar: choose one first', {
      code: 'primary_calendar_unset',
    });
    this.name = 'PrimaryCalendarUnsetError';
  }
}
