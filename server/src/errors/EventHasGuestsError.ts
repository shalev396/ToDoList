import { AppError } from './AppError.js';

/**
 * 409 `event_has_guests`: an edit or delete of a calendar event that has other guests, without
 * saying whether to notify them (`notifyGuests: true | false`). Moving or deleting a meeting
 * changes it for every guest, so it is never done by default. Nothing was sent.
 */
export class EventHasGuestsError extends AppError {
  constructor() {
    super(409, 'This event has other guests: say whether to notify them', {
      code: 'event_has_guests',
    });
    this.name = 'EventHasGuestsError';
  }
}
