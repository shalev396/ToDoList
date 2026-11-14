/**
 * Loads what the diff needs for one integration and runs it: the push filter (a Logic Bridge
 * query, compiled with the base filter like any /query) as the integration's owner, over their
 * own items only (their integrations and their own local to-dos: PERMISSIONS-V2 ruling 12, so no
 * other member's data leaves their control through this calendar), the live and recently
 * tombstoned links, and what is left of the daily creation cap.
 */
import { AppError } from '../errors/AppError.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import {
  getCalendarLinkRepository,
  getItemRepository,
  getSyncRunRepository,
} from '../models/index.js';
import type { RuleGroup } from '../types/builder.js';
import type { ItemQueryRow } from '../types/builder.js';
import { Actor } from '../classes/base/Actor.js';
import { Caller } from '../classes/base/Caller.js';
import { ItemPolicy } from '../classes/policies/ItemPolicy.js';
import { runWorkspaceQuery } from '../services/workspaceQuery.js';
import { zonedTime } from '../sync/transports/fixtureDates.js';
import {
  buildOps,
  TOMBSTONE_MS,
  type BuildResult,
  type PushConfig,
  type PushItem,
  type PushLink,
} from './diff.js';

/** Google allows 5,000 creations a day; we stop at 4,000. */
export const DAILY_CREATE_CAP = 4000;
export const DEFAULT_HORIZON_DAYS = 90;
export const DEFAULT_MAX_OPS = 50;
/** The most items one push query returns (CAPS.maxLimit). */
const QUERY_LIMIT = 200;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface CalendarEntry {
  id: string;
  mode: 'two_way' | 'read';
}

/** `Integrations.config` of a Google Calendar integration, with the defaults filled in. */
export interface GcalConfig {
  calendars: CalendarEntry[];
  targetCalendarId: string | null;
  pushFilter: unknown;
  horizonDays: number;
  maxOpsPerRun: number;
}

export function readGcalConfig(integration: IntegrationData): GcalConfig {
  const raw = integration.config;
  const calendars: CalendarEntry[] = [];
  if (Array.isArray(raw['calendars'])) {
    for (const entry of raw['calendars'] as unknown[]) {
      const id = (entry as { id?: unknown } | null)?.id;
      const mode = (entry as { mode?: unknown } | null)?.mode;
      if (typeof id === 'string' && id !== '') {
        calendars.push({ id, mode: mode === 'read' ? 'read' : 'two_way' });
      }
    }
  }
  const target = raw['targetCalendarId'];
  const horizon = raw['horizonDays'];
  const maxOps = raw['maxOpsPerRun'];
  return {
    calendars,
    targetCalendarId: typeof target === 'string' && target !== '' ? target : null,
    pushFilter: raw['pushFilter'],
    horizonDays: typeof horizon === 'number' ? horizon : DEFAULT_HORIZON_DAYS,
    maxOpsPerRun: typeof maxOps === 'number' ? maxOps : DEFAULT_MAX_OPS,
  };
}

/** Every item with a date. */
const DEFAULT_PUSH_FILTER = {
  source: 'items',
  where: {
    combinator: 'or',
    rules: [
      { field: 'dueAt', operator: 'notNull' },
      { field: 'startAt', operator: 'notNull' },
    ],
  },
} as const;

/** Narrows the plan to some items (the MCP dry run): nothing is deleted then. */
export interface PlanNarrowing {
  where?: RuleGroup;
  range?: { from?: string; to?: string };
}

export interface LoadedPlan extends BuildResult {
  cfg: PushConfig;
  config: GcalConfig;
}

function andWhere(base: unknown, extra: RuleGroup): RuleGroup {
  const rules: RuleGroup['rules'] = [];
  if (typeof base === 'object' && base !== null) rules.push(base as RuleGroup);
  rules.push(extra);
  return { combinator: 'and', rules };
}

function pushQuery(config: GcalConfig, narrowing: PlanNarrowing | undefined, tz: string): unknown {
  const filter: unknown = config.pushFilter ?? DEFAULT_PUSH_FILTER;
  const base = (typeof filter === 'object' && filter !== null ? filter : DEFAULT_PUSH_FILTER) as {
    where?: unknown;
  };
  const query: Record<string, unknown> = { ...base, source: 'items', limit: QUERY_LIMIT };
  if (narrowing?.where !== undefined) query['where'] = andWhere(base.where, narrowing.where);
  const range = narrowing?.range;
  if (range?.from !== undefined || range?.to !== undefined) {
    const from = range.from === undefined ? new Date(0) : localMidnight(range.from, tz);
    const to =
      range.to === undefined
        ? new Date('2100-01-01T00:00:00Z')
        : new Date(localMidnight(range.to, tz).getTime() + DAY_MS);
    query['dateRange'] = { from: from.toISOString(), to: to.toISOString() };
    query['dateField'] = 'any';
  }
  return query;
}

function localMidnight(day: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return zonedTime(
    { year: year ?? 1970, month: month ?? 1, day: date ?? 1, hour: 0, minute: 0 },
    timeZone,
  );
}

/** Creations still allowed today: the cap minus what runs of the last 24 hours created. */
export async function remainingCreates(integration: IntegrationData, now: Date): Promise<number> {
  const runs = await (
    await getSyncRunRepository()
  ).listForIntegration(integration.workspaceId, integration.id, 100);
  let used = 0;
  for (const run of runs) {
    const push = run.trigger === 'calendar_push';
    if (push && now.getTime() - run.startedAt.getTime() < DAY_MS) {
      used += run.counts['created'] ?? 0;
    }
  }
  return Math.max(0, DAILY_CREATE_CAP - used);
}

/** Items to push → ops, for `integration` at `now`. Throws 409 when its member is gone. */
export async function loadPlan(
  integration: IntegrationData,
  now: Date,
  narrowing?: PlanNarrowing,
): Promise<LoadedPlan> {
  const { workspaceId } = integration;
  const config = readGcalConfig(integration);
  const owner = integration.ownerUserId;
  const caller = await Caller.enter(workspaceId, Actor.user(owner));
  if (caller === null) {
    throw new AppError(409, 'The member who connected this integration is gone');
  }
  const ctx = caller.context;
  const timeZone = ctx.settings.timezone;

  const result = await runWorkspaceQuery(
    ctx,
    owner,
    { draft: pushQuery(config, narrowing, timeZone) },
    now,
    await ItemPolicy.ownFor(caller),
  );
  const rows = (result.rows ?? []).filter(
    (row): row is ItemQueryRow => 'kind' in row && row.source.provider !== 'google_calendar',
  );
  const truncated = result.total > (result.rows ?? []).length;

  const edits = await updatedAtOf(
    workspaceId,
    rows.map((row) => row.id),
  );
  const items: PushItem[] = rows.map((row) => {
    const updated = edits.get(row.id) ?? null;
    const edited = row.overlay.editedAt;
    return {
      id: row.id,
      title: row.title,
      startAt: row.startAt,
      dueAt: row.dueAt,
      endAt: row.endAt,
      allDay: row.allDay,
      source: { provider: row.source.provider, url: row.source.url },
      calendarSync: row.overlay.calendarSync,
      editedAt:
        updated !== null && edited !== null
          ? new Date(Math.max(+updated, +edited))
          : (updated ?? edited),
    };
  });

  const linkRepo = await getCalendarLinkRepository();
  const [live, stones] = await Promise.all([
    linkRepo.listLive(workspaceId, integration.id),
    linkRepo.listTombstonedSince(
      workspaceId,
      integration.id,
      new Date(now.getTime() - TOMBSTONE_MS),
    ),
  ]);
  const links: PushLink[] = [...live, ...stones];

  const cfg: PushConfig = {
    workspaceId,
    calendarId: config.targetCalendarId,
    timeZone,
    horizonDays: config.horizonDays,
    maxOps: config.maxOpsPerRun,
    maxCreates: await remainingCreates(integration, now),
    allowDelete: !truncated && narrowing === undefined,
  };
  return { ...buildOps(items, links, cfg, now), cfg, config };
}

async function updatedAtOf(
  workspaceId: string,
  ids: readonly string[],
): Promise<Map<string, Date>> {
  if (ids.length === 0) return new Map();
  const docs = await (
    await getItemRepository()
  ).aggregate<{ _id: string; updatedAt?: Date }>(workspaceId, [
    { $match: { _id: { $in: [...ids] } } },
    { $project: { updatedAt: 1 } },
  ]);
  const out = new Map<string, Date>();
  for (const doc of docs) if (doc.updatedAt instanceof Date) out.set(doc._id, doc.updatedAt);
  return out;
}
