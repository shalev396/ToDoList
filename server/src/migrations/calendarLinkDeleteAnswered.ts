/**
 * A `dashboard` CalendarLinks tombstone is TodoList's claim on an event (EventClaim), and
 * `deleteAnsweredAt` is when Google answered its DELETE. Every such tombstone written before the
 * field existed was written by the old code after Google answered (it tombstoned only after the
 * delete), so it gets `deleteAnsweredAt = tombstonedAt`. Without it, those rows would read as
 * claims still unanswered, and the stuck-claim sweep would read every one of them again.
 *
 * Counts only, never a value. Idempotent: only rows without the field are touched.
 */
import { CALENDAR_LINK_TABLE_NAME } from '../models/definitions/CalendarLink.js';
import type { Db, Migration } from './types.js';

export const calendarLinkDeleteAnswered: Migration = {
  id: '2026-11-15-calendar-link-delete-answered',
  async run(db: Db) {
    const result = await db.collection(CALENDAR_LINK_TABLE_NAME).updateMany(
      {
        deletedBy: 'dashboard',
        tombstonedAt: { $type: 'date' },
        deleteAnsweredAt: { $exists: false },
      },
      [{ $set: { deleteAnsweredAt: '$tombstonedAt' } }],
    );
    return { settled: result.modifiedCount };
  },
};
