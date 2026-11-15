/**
 * The workspace's primary calendar is always a read calendar of its integration (any mode;
 * `two_way` counts). For every workspace with `settings.primaryCalendar`, its calendar is added
 * to that Google Calendar integration's `config.calendars` as `{id, mode: 'read'}` when missing.
 * A primary whose integration is missing, deleted, in another workspace or not Google Calendar is skipped,
 * and so is one that already lists it (an object entry, or a legacy plain id) or holds 50 calendars.
 *
 * Counts only, never a value (`skipped`: already listed, or no such Google Calendar integration). Idempotent.
 */
import { INTEGRATION_TABLE_NAME } from '../models/definitions/Integration.js';
import { WORKSPACE_TABLE_NAME } from '../models/definitions/Workspace.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

function isRecord(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export const primaryCalendarRead: Migration = {
  id: '2026-11-15-primary-calendar-read',
  async run(db: Db) {
    const integrations = db.collection<Doc>(INTEGRATION_TABLE_NAME);
    const workspaces = db.collection<Doc>(WORKSPACE_TABLE_NAME);
    const withPrimary = await workspaces
      .find({ 'settings.primaryCalendar': { $type: 'object' }, deletedAt: null })
      .toArray();
    let added = 0;
    let skipped = 0;
    for (const workspace of withPrimary) {
      const settings = isRecord(workspace['settings']) ? workspace['settings'] : {};
      const primary = settings['primaryCalendar'];
      const integrationId = isRecord(primary) ? primary['integrationId'] : null;
      const calendarId = isRecord(primary) ? primary['calendarId'] : null;
      if (typeof integrationId !== 'string' || typeof calendarId !== 'string') {
        skipped += 1;
        continue;
      }
      const result = await integrations.updateOne(
        {
          _id: integrationId as never,
          workspaceId: String(workspace._id),
          provider: 'google_calendar',
          deletedAt: null,
          // Not yet read: no object entry with this id, no legacy plain-string entry of it, and
          // room left (the definition allows 50).
          'config.calendars': { $nin: [calendarId], $not: { $elemMatch: { id: calendarId } } },
          'config.calendars.49': { $exists: false },
        },
        { $push: { 'config.calendars': { id: calendarId, mode: 'read' } } as never },
      );
      if (result.matchedCount === 0) skipped += 1;
      added += result.modifiedCount;
    }
    return { added, skipped };
  },
};
