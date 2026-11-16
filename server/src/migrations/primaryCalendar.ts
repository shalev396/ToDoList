/**
 * The workspace's primary calendar replaces each Google Calendar connection's push target (plan
 * Addendum A2). For every workspace with a connection that stored a `targetCalendarId`:
 * 1. when the workspace has no primary calendar yet, the oldest such connection that the owner
 *    rules allow becomes it, with its target as the calendar: live, connected with Google
 *    (`oauth`), read & write, and owned by an active member whose role is `owner` (a workspace
 *    owner choosing among the integrations they own);
 * 2. every Google Calendar connection then loses `targetCalendarId` and `pushFilter` (the push
 *    rule is fixed now), deleted ones included, so no stored config names them again.
 *
 * Counts only, never a value. Idempotent: a workspace with a primary calendar is never changed,
 * and a config without either key matches nothing.
 */
import { INTEGRATION_TABLE_NAME } from '../models/definitions/Integration.js';
import { MEMBERSHIP_TABLE_NAME } from '../models/definitions/Membership.js';
import { WORKSPACE_TABLE_NAME } from '../models/definitions/Workspace.js';
import type { Db, Migration } from './types.js';

type Doc = Record<string, unknown>;

/** A Google calendar id as the Calendar API's: one run of visible characters. */
const CALENDAR_ID = /^\S{1,255}$/;

function isRecord(value: unknown): value is Doc {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function targetOf(integration: Doc): string | null {
  const config = isRecord(integration['config']) ? integration['config'] : {};
  const target = config['targetCalendarId'];
  return typeof target === 'string' && CALENDAR_ID.test(target) ? target : null;
}

function createdAt(doc: Doc): number {
  const at = doc['createdAt'];
  return at instanceof Date ? at.getTime() : 0;
}

export const primaryCalendar: Migration = {
  id: '2026-11-15-primary-calendar',
  async run(db: Db) {
    const integrations = db.collection<Doc>(INTEGRATION_TABLE_NAME);
    const workspaces = db.collection<Doc>(WORKSPACE_TABLE_NAME);
    const memberships = db.collection<Doc>(MEMBERSHIP_TABLE_NAME);

    const withTarget = await integrations
      .find({ provider: 'google_calendar', 'config.targetCalendarId': { $exists: true } })
      .toArray();
    const byWorkspace = new Map<string, Doc[]>();
    for (const integration of withTarget) {
      const workspaceId = integration['workspaceId'];
      if (typeof workspaceId !== 'string') continue;
      byWorkspace.set(workspaceId, [...(byWorkspace.get(workspaceId) ?? []), integration]);
    }

    let primarySet = 0;
    for (const [workspaceId, candidates] of byWorkspace) {
      const workspace = await workspaces.findOne({ _id: workspaceId as never, deletedAt: null });
      if (workspace === null) continue;
      const settings = isRecord(workspace['settings']) ? workspace['settings'] : {};
      if (isRecord(settings['primaryCalendar'])) continue;
      const owners = new Set(
        (
          await memberships
            .find({ workspaceId, role: 'owner', status: 'active' }, { projection: { userId: 1 } })
            .toArray()
        ).map((membership) => membership['userId']),
      );
      const chosen = [...candidates]
        .sort((a, b) => createdAt(a) - createdAt(b))
        .find(
          (integration) =>
            integration['deletedAt'] === null &&
            integration['authMethod'] === 'oauth' &&
            integration['mode'] === 'read_write' &&
            owners.has(integration['ownerUserId']) &&
            targetOf(integration) !== null,
        );
      const calendarId = chosen === undefined ? null : targetOf(chosen);
      if (chosen === undefined || calendarId === null) continue;
      const result = await workspaces.updateOne(
        {
          _id: workspaceId as never,
          deletedAt: null,
          $or: [
            { 'settings.primaryCalendar': { $exists: false } },
            { 'settings.primaryCalendar': null },
          ],
        },
        {
          $set: {
            'settings.primaryCalendar': { integrationId: String(chosen['_id']), calendarId },
          },
        },
      );
      primarySet += result.modifiedCount;
    }

    const cleaned = await integrations.updateMany(
      {
        provider: 'google_calendar',
        $or: [
          { 'config.targetCalendarId': { $exists: true } },
          { 'config.pushFilter': { $exists: true } },
        ],
      },
      { $unset: { 'config.targetCalendarId': '', 'config.pushFilter': '' } },
    );
    return {
      primarySet,
      targetsDropped: withTarget.length - primarySet,
      configsCleaned: cleaned.modifiedCount,
    };
  },
};
