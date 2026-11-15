/**
 * The commit of one calendar push + pull (OAuth Calendar API), a method object: the op results
 * and the Google changes the pull listed, then the run's end (SyncRun) and its integration's.
 * Calendar#commit runs it for the calendar the push wrote to.
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

import { Actor } from '../base/Actor.js';
import { AuditTarget } from '../base/AuditTarget.js';
import { AuditLog } from '../AuditLog.js';
import { Overrides } from '../item/Overrides.js';
import { PlannedAt } from '../item/PlannedAt.js';
import { SyncCursors } from '../sync/SyncCursors.js';
import { SyncRun } from '../sync/SyncRun.js';
import { WorkspaceSettings } from '../workspace/WorkspaceSettings.js';
import { AppError } from '../../errors/AppError.js';
import { eventIdFor, hashEvent, parseOpId, projectEvent, type PushItem } from '../../gcal/diff.js';
import type { CalendarLinkData } from '../../models/definitions/CalendarLink.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { ItemData } from '../../models/definitions/Item.js';
import {
  getCalendarLinkRepository,
  getIntegrationRepository,
  getItemRepository,
  getWorkspaceRepository,
} from '../../models/index.js';
import { redactString } from '../../services/secretPatterns.js';

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
 * exactly as Calendar#plan projects them, so what was pushed and what is compared agree.
 */
export function toPushItem(item: ItemData): PushItem {
  const edits = [item.updatedAt, item.overlay.editedAt].filter((d): d is Date => d !== null);
  const effective = Overrides.from(item.overlay.overrides).effective(item);
  return {
    id: item.id,
    title: redactString(effective.title),
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

export class PushCommit {
  readonly #integration: IntegrationData;
  readonly #workspaceId: string;
  readonly #run: SyncRun;
  readonly #timeZone: string;
  /** Where this run's creates went: the primary calendar the push wrote to. */
  readonly #primaryCalendarId: string | null;
  /** The integration owner's own integrations: their items may change from Google's side. */
  readonly #ownIntegrations: ReadonlySet<string>;
  readonly #counts: CommitCounts = {
    pulled: 0,
    created: 0,
    updated: 0,
    deleted: 0,
    echoesSkipped: 0,
    conflicts: 0,
  };
  #failures = 0;

  private constructor(state: {
    integration: IntegrationData;
    run: SyncRun;
    timeZone: string;
    primaryCalendarId: string | null;
    ownIntegrations: ReadonlySet<string>;
  }) {
    this.#integration = state.integration;
    this.#workspaceId = state.integration.workspaceId;
    this.#run = state.run;
    this.#timeZone = state.timeZone;
    this.#primaryCalendarId = state.primaryCalendarId;
    this.#ownIntegrations = state.ownIntegrations;
  }

  /**
   * Applies one commit and closes its run. Throws AppError(409) for a run that is not open.
   * `pushedTo` is the primary calendar the push wrote to (its creates' calendar); without it, the
   * workspace's primary calendar as it is now, when it is on this integration.
   */
  static async apply(
    integration: IntegrationData,
    input: unknown,
    now: Date = new Date(),
    pushedTo?: string,
  ): Promise<CommitCounts> {
    const parsed = CommitBody.safeParse(input);
    if (!parsed.success) throw new AppError(400, 'Invalid commit');
    const body = parsed.data;
    const { workspaceId } = integration;
    const run = await SyncRun.find(workspaceId, body.runId);
    if (run?.integrationId !== integration.id || run.status !== 'running') {
      throw new AppError(409, 'No such open run');
    }
    const workspace = await (await getWorkspaceRepository()).findById(workspaceId);
    if (workspace === null) throw new AppError(404, 'Workspace not found');
    const primary = WorkspaceSettings.from(workspace.settings).primaryCalendar;
    const own = await (
      await getIntegrationRepository()
    ).listForOwner(workspaceId, integration.ownerUserId);
    const commit = new PushCommit({
      integration,
      run,
      timeZone: workspace.settings.timezone,
      primaryCalendarId:
        pushedTo ?? (primary?.isOn(integration.id) === true ? primary.calendarId : null),
      ownIntegrations: new Set(own.map((entry) => entry.id)),
    });
    return commit.#apply(body, now);
  }

  async #apply(body: CommitBody, now: Date): Promise<CommitCounts> {
    for (const result of body.opResults) await this.#applyOpResult(result);
    let partial = false;
    for (const cal of body.calendars) {
      partial ||= cal.partial === true;
      await this.#applyCalendar(cal, now);
    }
    await this.#run.succeed(
      { counts: { ...this.#counts } },
      { finishedAt: now, partial: this.#failures > 0 || partial },
    );
    await (
      await getIntegrationRepository()
    ).recordSyncResult(this.#workspaceId, this.#integration.id, {
      status: 'active',
      lastSyncAt: now,
      lastError: null,
    });
    return this.#counts;
  }

  /** A calendar push run is the system acting in the integration's workspace. */
  get #system(): { workspaceId: string; actor: Actor } {
    return { workspaceId: this.#workspaceId, actor: Actor.system() };
  }

  /** What every entry of a run names: the run and its integration, then the entry's own meta. */
  #meta(meta: Record<string, unknown>): Record<string, unknown> {
    return { runId: this.#run.id, integrationId: this.#integration.id, ...meta };
  }

  // ─── op results ───────────────────────────────────────────────────────────

  async #applyOpResult(result: z.infer<typeof OpResult>): Promise<void> {
    const op = parseOpId(result.opId);
    if (op === null) {
      this.#failures += 1;
      return;
    }
    if (!result.ok) {
      if (result.code === 'conflict') this.#counts.conflicts += 1;
      else this.#failures += 1;
      return;
    }
    const workspaceId = this.#workspaceId;
    const links = await getCalendarLinkRepository();
    const link = await links.findByItem(workspaceId, this.#integration.id, op.itemId);
    if (op.type === 'delete') {
      if (link !== null && link.tombstonedAt === null) {
        await links.tombstone(workspaceId, link.id, 'dashboard');
      }
      this.#counts.deleted += 1;
      await AuditLog.record(
        this.#system,
        'gcal.write',
        AuditTarget.of('item', op.itemId),
        this.#meta({ op: 'delete', eventId: link?.googleEventId ?? null }),
      );
      return;
    }
    const item = await (await getItemRepository()).findById(workspaceId, op.itemId);
    const calendarId =
      op.type === 'update' && link?.tombstonedAt === null
        ? link.calendarId
        : this.#primaryCalendarId;
    if (calendarId === null) {
      this.#failures += 1;
      return;
    }
    const eventId = result.eventId ?? link?.googleEventId ?? eventIdFor(op.itemId);
    await links.upsert(
      workspaceId,
      this.#integration.id,
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
    await links.removeOthersForEvent(workspaceId, this.#integration.id, {
      calendarId,
      googleEventId: eventId,
    });
    if (op.type === 'create') this.#counts.created += 1;
    else this.#counts.updated += 1;
    await AuditLog.record(
      this.#system,
      'gcal.write',
      AuditTarget.of('item', op.itemId),
      this.#meta({ op: op.type, eventId }),
    );
  }

  // ─── pulled events ────────────────────────────────────────────────────────

  /**
   * Whether the run's integration owner owns the item: their own local to-do, or an item of one of
   * their own integrations. Only such an item may change from Google's side (I6): another member's
   * shared item is theirs, whoever can edit the owner's calendar.
   */
  #ownedByOwner(item: ItemData): boolean {
    return isLocal(item)
      ? item.ownerUserId === this.#integration.ownerUserId
      : item.integrationId !== null && this.#ownIntegrations.has(item.integrationId);
  }

  async #applyLinkedEvent(
    calendarId: string,
    ev: SlimEvent,
    link: CalendarLinkData,
  ): Promise<void> {
    const workspaceId = this.#workspaceId;
    const links = await getCalendarLinkRepository();
    if (link.tombstonedAt !== null) return;
    const items = await getItemRepository();
    const item = await items.findById(workspaceId, link.itemId);
    if (item?.deletedAt !== null) return;
    const owned = this.#ownedByOwner(item);

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
      this.#counts.deleted += 1;
      await AuditLog.record(
        this.#system,
        'gcal.delete',
        AuditTarget.of('item', item.id),
        this.#meta({ source: 'google', eventId: ev.id, ...(owned ? {} : { itemKept: true }) }),
      );
      return;
    }
    if (ev.etag !== undefined && ev.etag === link.lastEtag) {
      this.#counts.echoesSkipped += 1;
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
      this.#counts.conflicts += 1;
      await AuditLog.record(
        this.#system,
        'gcal.conflict',
        AuditTarget.of('item', item.id),
        this.#meta({
          winner: googleWins ? 'google' : 'dashboard',
          google: { summary: redactString(typeof ev['summary'] === 'string' ? ev['summary'] : '') },
          dashboard: { title: redactString(item.title) },
        }),
      );
    }

    if (!googleWins || !owned) {
      // Our version stays: it is pushed over Google's on the next run (with Google's new etag).
      await links.upsert(workspaceId, this.#integration.id, key, { ...base, pushedHash: null });
      return;
    }
    // Google wins, on the owner's own item. Its time becomes the item's plan (`overlay.plannedAt`;
    // a due or start date is the provider's or the item's own, never the calendar's); a to-do takes
    // Google's title too. Nothing is ever written to a provider.
    const before = projectEvent(toPushItem(item), workspaceId, this.#timeZone);
    const start = timeOf(ev['start']);
    const moved = !sameStart(before?.start, start);
    const plan = moved ? PlannedAt.fromEventStart(start, this.#timeZone) : null;
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
    const projection = projectEvent(toPushItem(updated), workspaceId, this.#timeZone);
    // Idle next run when the new projection is what Google shows (its time, and its title for a
    // to-do); a mirrored item's title, or a time no plan can hold, is pushed back over Google's.
    const settled =
      projection !== null &&
      (plan !== null || !moved) &&
      (isLocal(item) || title === null || title === projection.summary);
    await links.upsert(workspaceId, this.#integration.id, key, {
      ...base,
      lastItemUpdatedAt: toPushItem(updated).editedAt ?? updated.updatedAt,
      pushedHash: settled ? hashEvent(projection) : null,
    });
    if (changed) this.#counts.updated += 1;
  }

  async #applyCalendar(cal: z.infer<typeof CalendarResult>, now: Date): Promise<void> {
    const workspaceId = this.#workspaceId;
    const integration = this.#integration;
    const links = await getCalendarLinkRepository();
    const resource = `gcal:${cal.id}`;
    const cursors = SyncCursors.of(integration);
    if (cal.reset === true) {
      // 410 Gone: the token is dead; the next begin lists in full.
      await cursors.save(resource, { syncToken: null });
      return;
    }
    this.#counts.pulled += cal.events.length;
    for (const ev of cal.events) {
      const link = await links.findByEvent(workspaceId, integration.id, {
        calendarId: cal.id,
        googleEventId: ev.id,
      });
      if (link !== null) await this.#applyLinkedEvent(cal.id, ev, link);
      // An event with no link (ours with a purged tombstone, another dashboard's, or Google-native):
      // ignored here; the sync engine's pull maps Google-native events.
    }
    if (cal.partial !== true && typeof cal.nextSyncToken === 'string' && cal.nextSyncToken !== '') {
      await cursors.save(resource, {
        syncToken: cal.nextSyncToken,
        consecutiveErrors: 0,
        ...(cal.fullSync === true ? { lastFullSyncAt: now } : { lastIncrementalAt: now }),
      });
    }
  }
}
