import { AppError } from './AppError.js';

/**
 * 409 `calendar_not_primary`: TodoList pushes only to the workspace's primary calendar (plan
 * Addendum A2), and this Google Calendar integration is not the one it is on (or none is set).
 * A workspace owner chooses the primary calendar; nothing was planned or sent.
 */
export class CalendarNotPrimaryError extends AppError {
  readonly integrationId: string;

  constructor(integrationId: string) {
    super(409, 'This Google Calendar is not the workspace calendar: TodoList sends only there', {
      code: 'calendar_not_primary',
    });
    this.name = 'CalendarNotPrimaryError';
    this.integrationId = integrationId;
  }
}
