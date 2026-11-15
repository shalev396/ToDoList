/**
 * The commit of one calendar push + pull (OAuth Calendar API): the op results and the Google
 * changes the pull listed.
 *
 * - op results: a created or updated event gets its link (etag, hash, times), and another
 *   integration's live link to that same event goes (one tracker per event); a delete gets its
 *   tombstone; a create went to the workspace's primary calendar (its link moves there when the
 *   primary calendar changed), an update to its link's calendar; every write is audited
 *   (`gcal.write`); a 412 is a conflict, settled by the next pull;
 * - echoes (`etag == link.lastEtag`) are our own writes and are skipped;
 * - a changed event of a linked item: last write wins between Google's `updated` and the user's
 *   edit time (a tie goes to Google); the loser's values go to `AuditLogs.meta`, redacted. When
 *   Google wins, its new time becomes the item's plan (`overlay.plannedAt`): the calendar never
 *   writes a due or start date, and a provider is never written to; a to-do takes Google's title;
 *   a mirrored item's title is pushed back over Google's;
 * - only the integration owner's own items change from Google's side (their to-dos, and their own
 *   integrations' items): another member's shared item is never edited or deleted there; its
 *   edits lose (re-pushed), and its delete only tombstones the link (not made again unless edited);
 * - a Google-side delete of an owner's item soft-deletes a local one, or sets
 *   `overlay.calendarSync=false` on a mirrored one, and tombstones the link; the provider is never
 *   touched;
 * - events with no link are ignored here (the sync engine's pull maps Google-native ones); the
 *   pull keeps a sync token apart from the engine's (`gcal:<id>`, not `calendar:<id>`);
 * - `nextSyncToken` is saved only when the calendar's listing was complete; `reset` clears it.
 */
import { z } from 'zod';

import { Actor } from '../classes/base/Actor.js';
import { AuditTarget } from '../classes/base/AuditTarget.js';
import { AuditLog } from '../classes/AuditLog.js';
import { AppError } from '../errors/AppError.js';
import type { CalendarLinkData } from '../models/definitions/CalendarLink.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import type { ItemData } from '../models/definitions/Item.js';
import {
  getCalendarLinkRepository,
  getIntegrationRepository,
  getItemRepository,
  getSyncRunRepository,
  getSyncStateRepository,
  getWorkspaceRepository,
} from '../models/index.js';
import { redactString } from '../services/secretPatterns.js';
import { PlannedAt } from '../classes/item/PlannedAt.js';
import { Overrides } from '../classes/item/Overrides.js';
import { WorkspaceSettings } from '../classes/workspace/WorkspaceSettings.js';
import { eventIdFor, hashEvent, parseOpId, projectEvent, type PushItem } from './diff.js';

const OpResult = z.object({
  opId: z.string().max(200),
  ok: z.boolean(),
  code: z.string().max(40).optional(),
  eventId: z.string().max(1024).optional(),
  etag: z.string().max(200).optional(),
  updated: z.string().max(40).optional(),
});

const SlimEvent = z.looseObject({
  id: z.string().min(1).max(1024),
  status: z.string().max(20).optional(),
  etag: z.string().max(200).optional(),
  updated: z.string().max(40).optional(),
  priv: z.record(z.string(), z.unknown()).nullable().optional(),
});

const CalendarResult = z.object({
  id: z.string().min(1).max(1024),
  events: z.array(SlimEvent).max(5000).default([]),
  nextSyncToken: z.string().max(2048).nullable().optional(),
  fullSync: z.boolean().optional(),
  reset: z.boolean().optional(),
  partial: z.boolean().optional(),
});

export const CommitBody = z.object({
  runId: z.string().min(1).max(100),
  opResults: z.array(OpResult).max(500).default([]),
  calendars: z.array(CalendarResult).max(50).default([]),
});
export type CommitBody = z.infer<typeof CommitBody>;
type SlimEvent = z.infer<typeof SlimEvent>;

export interface CommitCounts {
  pulled: number;
  created: number;
  updated: number;
  deleted: number;
  echoesSkipped: number;
  conflicts: number;
}

/**
 * The item as the push reads it: its effective values (a mirrored item's overrides, Overrides),
 * exactly as plan.ts projects them, so what was pushed and what is compared agree.
 */
export function toPushItem(item: ItemData): PushItem {
  const edits = [item.updatedAt, item.overlay.editedAt].filter((d): d is Date => d !== null);
  const effective = Overrides.from(item.overlay.overrides).effective(item);
  return {
    id: item.id,
    title: effective.title,
    startAt: effective.startAt,
    dueAt: effective.dueAt,
    endAt: item.endAt,
    allDay: effective.allDay,
    source: { provider: item.source.provider, url: item.source.url },
    calendarSync: item.overlay.calendarSync,
    plannedAt: item.overlay.plannedAt,
    editedAt: edits.length === 0 ? null : new Date(Math.max(...edits.map((d) => d.getTime()))),
  };
}

const editTimeOf = (item: ItemData): number => toPushItem(item).editedAt?.getTime() ?? 0;
const isLocal = (item: ItemData): boolean => item.source.provider === 'local';
const instant = (value: string | undefined): Date | null => {
  const at = value === undefined ? Number.NaN : Date.parse(value);
  return Number.isNaN(at) ? null : new Date(at);
};

interface Run {
  integration: IntegrationData;
  workspaceId: string;
  runId: string;
  timeZone: string;
  /** Where this run's creates went: the primary calendar the push wrote to. */
  primaryCalendarId: string | null;
  /** The integration owner's own integrations: their items may change from Google's side. */
  ownIntegrations: ReadonlySet<string>;
  counts: CommitCounts;
  failures: number;
}

/** A calendar push run is the system acting in the integration's workspace. */
function systemIn(run: Run): { workspaceId: string; actor: Actor } {
  return { workspaceId: run.workspaceId, actor: Actor.system() };
}

/** What every entry of a run names: the run and its integration, then the entry's own meta. */
function runMeta(run: Run, meta: Record<string, unknown>): Record<string, unknown> {
  return { runId: run.runId, integrationId: run.integration.id, ...meta };
}

// ─── op results ─────────────────────────────────────────────────────────────

async function applyOpResult(run: Run, result: z.infer<typeof OpResult>): Promise<void> {
  const op = parseOpId(result.opId);
  if (op === null) {
    run.failures += 1;
    return;
  }
  if (!result.ok) {
    if (result.code === 'conflict') run.counts.conflicts += 1;
    else run.failures += 1;
    return;
  }
  const { workspaceId } = run;
  const links = await getCalendarLinkRepository();
  const link = await links.findByItem(workspaceId, run.integration.id, op.itemId);
  if (op.type === 'delete') {
    if (link !== null && link.tombstonedAt === null) {
      await links.tombstone(workspaceId, link.id, 'dashboard');
    }
    run.counts.deleted += 1;
    await AuditLog.record(
      systemIn(run),
      'gcal.write',
      AuditTarget.of('item', op.itemId),
      runMeta(run, {
        op: 'delete',
        eventId: link?.googleEventId ?? null,
      }),
    );
    return;
  }
  const item = await (await getItemRepository()).findById(workspaceId, op.itemId);
  const calendarId =
    op.type === 'update' && link?.tombstonedAt === null ? link.calendarId : run.primaryCalendarId;
  if (calendarId === null) {
    run.failures += 1;
    return;
  }
  const eventId = result.eventId ?? link?.googleEventId ?? eventIdFor(op.itemId);
  await links.upsert(
    workspaceId,
    run.integration.id,
    { calendarId, googleEventId: eventId },
    {
      itemId: op.itemId,
      direction: 'to_google',
      lastEtag: result.etag ?? null,
      lastGoogleUpdated: instant(result.updated),
      lastItemUpdatedAt: item === null ? new Date() : (toPushItem(item).editedAt ?? new Date(0)),
      pushedHash: op.hash,
      tombstonedAt: null,
      deletedBy: null,
    },
  );
  // One tracker per event: another integration of the workspace that pushed this same event (the
  // ids are per item, so a create adopts it) no longer tracks it, so its pull or clean-up can never
  // read our later delete or move as its own (rows only; nothing is sent to Google).
  await links.removeOthersForEvent(workspaceId, run.integration.id, {
    calendarId,
    googleEventId: eventId,
  });
  if (op.type === 'create') run.counts.created += 1;
  else run.counts.updated += 1;
  await AuditLog.record(
    systemIn(run),
    'gcal.write',
    AuditTarget.of('item', op.itemId),
    runMeta(run, { op: op.type, eventId }),
  );
}

// ─── pulled events ──────────────────────────────────────────────────────────

/** An event time as Google sends it: a day, or an instant. */
interface EventTimeLike {
  date?: unknown;
  dateTime?: unknown;
}

const timeOf = (value: unknown): EventTimeLike | undefined =>
  typeof value === 'object' && value !== null ? value : undefined;

/** Whether two event starts are the same day, or the same instant. */
function sameStart(a: EventTimeLike | undefined, b: EventTimeLike | undefined): boolean {
  if (typeof a?.date === 'string' || typeof b?.date === 'string') return a?.date === b?.date;
  if (typeof a?.dateTime !== 'string' || typeof b?.dateTime !== 'string') return false;
  return Date.parse(a.dateTime) === Date.parse(b.dateTime);
}

/**
 * Whether the run's integration owner owns the item: their own local to-do, or an item of one of
 * their own integrations. Only such an item may change from Google's side (I6): another member's
 * shared item is theirs, whoever can edit the owner's calendar.
 */
function ownedByOwner(run: Run, item: ItemData): boolean {
  return isLocal(item)
    ? item.ownerUserId === run.integration.ownerUserId
    : item.integrationId !== null && run.ownIntegrations.has(item.integrationId);
}

async function applyLinkedEvent(
  run: Run,
  calendarId: string,
  ev: SlimEvent,
  link: CalendarLinkData,
): Promise<void> {
  const { workspaceId } = run;
  const links = await getCalendarLinkRepository();
  if (link.tombstonedAt !== null) return;
  const items = await getItemRepository();
  const item = await items.findById(workspaceId, link.itemId);
  if (item?.deletedAt !== null) return;
  const owned = ownedByOwner(run, item);

  if (ev.status === 'cancelled') {
    // Deleted in Google. The owner's own item goes (a to-do) or stops projecting (a mirrored item;
    // the provider is never touched); another member's item is left as it is: only this link
    // goes (`google_kept`, which never ages out), so the event is not made again unless the item
    // is edited later.
    if (owned) {
      if (isLocal(item)) await items.softDelete(workspaceId, item.id);
      else await items.setOverlay(workspaceId, item.id, { calendarSync: false });
    }
    await links.tombstone(workspaceId, link.id, owned ? 'google' : 'google_kept');
    run.counts.deleted += 1;
    await AuditLog.record(
      systemIn(run),
      'gcal.delete',
      AuditTarget.of('item', item.id),
      runMeta(run, { source: 'google', eventId: ev.id, ...(owned ? {} : { itemKept: true }) }),
    );
    return;
  }
  if (ev.etag !== undefined && ev.etag === link.lastEtag) {
    run.counts.echoesSkipped += 1;
    return;
  }

  const googleAt = instant(ev.updated);
  const itemAt = editTimeOf(item);
  const dashboardChanged = itemAt > (link.lastItemUpdatedAt?.getTime() ?? 0);
  const key = { calendarId, googleEventId: ev.id };
  const base = {
    itemId: item.id,
    direction: link.direction,
    lastEtag: ev.etag ?? null,
    lastGoogleUpdated: googleAt,
  };
  const googleWins = !dashboardChanged || (googleAt?.getTime() ?? 0) >= itemAt;

  if (dashboardChanged) {
    run.counts.conflicts += 1;
    await AuditLog.record(
      systemIn(run),
      'gcal.conflict',
      AuditTarget.of('item', item.id),
      runMeta(run, {
        winner: googleWins ? 'google' : 'dashboard',
        google: { summary: redactString(typeof ev['summary'] === 'string' ? ev['summary'] : '') },
        dashboard: { title: redactString(item.title) },
      }),
    );
  }

  if (!googleWins || !owned) {
    // Our version stays: it is pushed over Google's on the next run (with Google's new etag).
    await links.upsert(workspaceId, run.integration.id, key, { ...base, pushedHash: null });
    return;
  }
  // Google wins, on the owner's own item. Its time becomes the item's plan (`overlay.plannedAt`;
  // a due or start date is the provider's or the item's own, never the calendar's); a to-do takes
  // Google's title too. Nothing is ever written to a provider.
  const before = projectEvent(toPushItem(item), workspaceId, run.timeZone);
  const start = timeOf(ev['start']);
  const moved = !sameStart(before?.start, start);
  const plan = moved ? PlannedAt.fromEventStart(start, run.timeZone) : null;
  const title = typeof ev['summary'] === 'string' ? ev['summary'] : null;
  let changed = false;
  if (plan !== null) {
    await items.setOverlay(workspaceId, item.id, { plannedAt: plan.toString() });
    changed = true;
  }
  if (isLocal(item) && title !== null && title.trim() !== '' && title !== item.title) {
    await items.updateLocal(workspaceId, item.id, { title });
    changed = true;
  }
  const updated = changed ? await items.findById(workspaceId, item.id) : item;
  if (updated === null) return;
  const projection = projectEvent(toPushItem(updated), workspaceId, run.timeZone);
  // Idle next run when the new projection is what Google shows (its time, and its title for a
  // to-do); a mirrored item's title, or a time no plan can hold, is pushed back over Google's.
  const settled =
    projection !== null &&
    (plan !== null || !moved) &&
    (isLocal(item) || title === null || title === projection.summary);
  await links.upsert(workspaceId, run.integration.id, key, {
    ...base,
    lastItemUpdatedAt: toPushItem(updated).editedAt ?? updated.updatedAt,
    pushedHash: settled ? hashEvent(projection) : null,
  });
  if (changed) run.counts.updated += 1;
}

async function applyCalendar(
  run: Run,
  cal: z.infer<typeof CalendarResult>,
  now: Date,
): Promise<void> {
  const { workspaceId, integration } = run;
  const links = await getCalendarLinkRepository();
  const resource = `gcal:${cal.id}`;
  const states = await getSyncStateRepository();
  if (cal.reset === true) {
    // 410 Gone: the token is dead; the next begin lists in full.
    await states.upsert(workspaceId, integration.id, resource, { syncToken: null });
    return;
  }
  run.counts.pulled += cal.events.length;
  for (const ev of cal.events) {
    const link = await links.findByEvent(workspaceId, integration.id, {
      calendarId: cal.id,
      googleEventId: ev.id,
    });
    if (link !== null) await applyLinkedEvent(run, cal.id, ev, link);
    // An event with no link (ours with a purged tombstone, another dashboard's, or Google-native):
    // ignored here; the sync engine's pull maps Google-native events.
  }
  if (cal.partial !== true && typeof cal.nextSyncToken === 'string' && cal.nextSyncToken !== '') {
    await states.upsert(workspaceId, integration.id, resource, {
      syncToken: cal.nextSyncToken,
      consecutiveErrors: 0,
      ...(cal.fullSync === true ? { lastFullSyncAt: now } : { lastIncrementalAt: now }),
    });
  }
}

// ─── the commit ─────────────────────────────────────────────────────────────

/**
 * Applies one commit and closes its run. Throws AppError(409) for a run that is not open.
 * `pushedTo` is the primary calendar the push wrote to (its creates' calendar); without it, the
 * workspace's primary calendar as it is now, when it is on this integration.
 */
export async function applyCommit(
  integration: IntegrationData,
  input: unknown,
  now: Date = new Date(),
  pushedTo?: string,
): Promise<CommitCounts> {
  const parsed = CommitBody.safeParse(input);
  if (!parsed.success) throw new AppError(400, 'Invalid commit');
  const body = parsed.data;
  const { workspaceId } = integration;
  const runs = await getSyncRunRepository();
  const open = await runs.findById(workspaceId, body.runId);
  if (open?.integrationId !== integration.id || open.status !== 'running') {
    throw new AppError(409, 'No such open run');
  }
  const workspace = await (await getWorkspaceRepository()).findById(workspaceId);
  if (workspace === null) throw new AppError(404, 'Workspace not found');
  const primary = WorkspaceSettings.from(workspace.settings).primaryCalendar;
  const own = await (
    await getIntegrationRepository()
  ).listForOwner(workspaceId, integration.ownerUserId);
  const run: Run = {
    integration,
    workspaceId,
    runId: body.runId,
    timeZone: workspace.settings.timezone,
    primaryCalendarId:
      pushedTo ?? (primary?.isOn(integration.id) === true ? primary.calendarId : null),
    ownIntegrations: new Set(own.map((entry) => entry.id)),
    counts: { pulled: 0, created: 0, updated: 0, deleted: 0, echoesSkipped: 0, conflicts: 0 },
    failures: 0,
  };
  for (const result of body.opResults) await applyOpResult(run, result);
  let partial = false;
  for (const cal of body.calendars) {
    partial ||= cal.partial === true;
    await applyCalendar(run, cal, now);
  }
  await runs.update(workspaceId, body.runId, {
    status: run.failures > 0 || partial ? 'partial' : 'succeeded',
    finishedAt: now,
    counts: { ...run.counts },
  });
  await (
    await getIntegrationRepository()
  ).recordSyncResult(workspaceId, integration.id, {
    status: 'active',
    lastSyncAt: now,
    lastError: null,
  });
  return run.counts;
}
