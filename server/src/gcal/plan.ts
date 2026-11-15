/**
 * Loads what the diff needs for the workspace's primary calendar and runs it (plan Addendum A2).
 * Only the integration the primary calendar is on is planned (409 `calendar_not_primary` for any
 * other), and only into that calendar.
 *
 * The push set is fixed, and read as one MongoDB filter over what the integration's owner may see
 * (ItemPolicy as them: their own integrations, the shared ones, and the to-dos they may see,
 * never another member's private one): every item dated within the push window (a planned date
 * `overlay.plannedAt`, a due date, or a start whose span reaches into it), except the items Google
 * Calendar itself mirrors (they are its events already) and those with `overlay.calendarSync ===
 * false`. It is read in two parts, so no cap ever hides an item:
 * - the items of the live links, all of them (in chunks): what to update or move, and, by their
 *   absence, which events to delete;
 * - the other items, page by page while the request's budget keeps WRITE_RESERVE_MS for the
 *   writes (a push plans and writes within one TimeBudget): what to create. One cut short only
 *   defers creates; the next run reads them first, since what was created is linked.
 * Then the recently tombstoned links, and what is left of the daily creation cap.
 */
import { AppError } from '../errors/AppError.js';
import { CalendarNotPrimaryError } from '../errors/CalendarNotPrimaryError.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import {
  getCalendarLinkRepository,
  getItemRepository,
  getSyncRunRepository,
} from '../models/index.js';
import type { RuleGroup } from '../types/builder.js';
import { compileQuery, parseQuery } from '../builder/compile.js';
import { Actor } from '../classes/base/Actor.js';
import { Caller } from '../classes/base/Caller.js';
import { CalendarLink } from '../classes/calendar/CalendarLink.js';
import { TimeBudget, WRITE_BUDGET_MS } from '../classes/integration/calendar/TimeBudget.js';
import { ItemPolicy } from '../classes/policies/ItemPolicy.js';
import { Overrides } from '../classes/item/Overrides.js';
import { AttributeDefinitions } from '../classes/workspace/AttributeDefinitions.js';
import { WorkspaceSettings } from '../classes/workspace/WorkspaceSettings.js';
import { redactString } from '../services/secretPatterns.js';
import { zonedTime } from '../sync/transports/fixtureDates.js';
import {
  buildOps,
  localDate,
  PAST_WINDOW_DAYS,
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
/** What the plan leaves of the request's budget for the writes and the pull that follow. */
export const WRITE_RESERVE_MS = 12_000;
/** Items read per page (and link items per chunk). */
const PAGE_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

type Filter = Record<string, unknown>;

export interface CalendarEntry {
  id: string;
  mode: 'two_way' | 'read';
}

/** `Integrations.config` of a Google Calendar integration, with the defaults filled in. */
export interface GcalConfig {
  calendars: CalendarEntry[];
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
  const horizon = raw['horizonDays'];
  const maxOps = raw['maxOpsPerRun'];
  return {
    calendars,
    horizonDays: typeof horizon === 'number' ? horizon : DEFAULT_HORIZON_DAYS,
    maxOpsPerRun: typeof maxOps === 'number' ? maxOps : DEFAULT_MAX_OPS,
  };
}

/** Narrows the plan to some items (the MCP dry run): nothing is deleted then. */
export interface PlanNarrowing {
  where?: RuleGroup;
  range?: { from?: string; to?: string };
}

export interface LoadedPlan extends BuildResult {
  /** `calendarId` is the primary calendar's. */
  cfg: PushConfig & { calendarId: string };
  config: GcalConfig;
}

/** A span of time, as instants and as the local dates a planned date is compared with. */
interface Span {
  from: Date;
  to: Date;
  fromDay: string;
  toDay: string;
}

function spanOf(from: Date, to: Date, timeZone: string): Span {
  return { from, to, fromDay: localDate(from, timeZone), toDay: localDate(to, timeZone) };
}

/**
 * Dated within `span`: a planned date (`YYYY-MM-DD…` compares as text), a due date, or a start
 * whose span (to its end) reaches into it. diff.ts's window check decides exactly.
 */
function datedWithin(span: Span): Filter {
  return {
    $or: [
      { 'overlay.plannedAt': { $gte: span.fromDay, $lte: `${span.toDay}T23:59` } },
      { dueAt: { $gte: span.from, $lte: span.to } },
      {
        startAt: { $lte: span.to },
        $or: [{ startAt: { $gte: span.from } }, { endAt: { $gte: span.from } }],
      },
    ],
  };
}

/**
 * The push set's own rules on what the sync stores: not Google Calendar's, not turned off. Being
 * dated in the window (datedWithin) is checked on the effective values, after the projection.
 */
function pushRule(): Filter[] {
  return [
    { 'source.provider': { $ne: 'google_calendar' } },
    { 'overlay.calendarSync': { $ne: false } },
  ];
}

function localMidnight(day: string, timeZone: string): Date {
  const [year, month, date] = day.split('-').map(Number);
  return zonedTime(
    { year: year ?? 1970, month: month ?? 1, day: date ?? 1, hour: 0, minute: 0 },
    timeZone,
  );
}

/** A dry run's narrowing: filters on the stored fields, and the stages its rules compile to. */
interface Narrowed {
  filters: Filter[];
  stages: Record<string, unknown>[];
}

/**
 * An MCP dry run's narrowing: its rules, compiled by the Logic Bridge like any query (every stage
 * between the base filter and the `$facet`, so a computed field such as Importance is added
 * before the filter that reads it), and its date range (planned dates included).
 */
function narrowingOf(
  narrowing: PlanNarrowing | undefined,
  caller: Caller,
  policy: ItemPolicy,
  now: Date,
): Narrowed {
  const narrowed: Narrowed = { filters: [], stages: [] };
  if (narrowing === undefined) return narrowed;
  const timeZone = caller.settings.timezone;
  if (narrowing.where !== undefined) {
    const compiled = compileQuery(parseQuery({ source: 'items', where: narrowing.where }), {
      ws: { id: caller.workspaceId },
      userId: caller.userId,
      access: policy.access,
      vars: {},
      now,
      timeZone,
      weekStart: caller.settings.weekStart,
      preview: false,
      attributes: AttributeDefinitions.of(caller.settings).toJSON(),
    });
    // The base filter's match first (already in `scope`), the `$facet` last: what is between is
    // the query's own work (computed fields, then its filters).
    const facet = compiled.pipeline.findIndex((stage) => '$facet' in stage);
    narrowed.stages = compiled.pipeline.slice(1, facet === -1 ? undefined : facet);
  }
  const range = narrowing.range;
  if (range?.from !== undefined || range?.to !== undefined) {
    const from = range.from === undefined ? new Date(0) : localMidnight(range.from, timeZone);
    const to =
      range.to === undefined
        ? new Date('2100-01-01T00:00:00Z')
        : new Date(localMidnight(range.to, timeZone).getTime() + DAY_MS - 1);
    narrowed.filters.push(datedWithin(spanOf(from, to, timeZone)));
  }
  return narrowed;
}

/** The fields the diff reads of an item. */
const PUSH_FIELDS = {
  title: 1,
  startAt: 1,
  dueAt: 1,
  endAt: 1,
  allDay: 1,
  'source.provider': 1,
  'source.url': 1,
  'overlay.calendarSync': 1,
  'overlay.plannedAt': 1,
  'overlay.editedAt': 1,
  updatedAt: 1,
} as const;

interface PushDoc {
  _id: string;
  title?: string;
  startAt?: Date | null;
  dueAt?: Date | null;
  endAt?: Date | null;
  allDay?: boolean;
  source?: { provider?: string; url?: string };
  overlay?: { calendarSync?: boolean | null; plannedAt?: string | null; editedAt?: Date | null };
  updatedAt?: Date;
}

const dateOr = (value: unknown): Date | null => (value instanceof Date ? value : null);

function toPushItem(doc: PushDoc): PushItem {
  const updated = dateOr(doc.updatedAt);
  const edited = dateOr(doc.overlay?.editedAt);
  return {
    id: doc._id,
    title: redactString(typeof doc.title === 'string' ? doc.title : ''),
    startAt: dateOr(doc.startAt),
    dueAt: dateOr(doc.dueAt),
    endAt: dateOr(doc.endAt),
    allDay: doc.allDay === true,
    source: { provider: doc.source?.provider ?? '', url: doc.source?.url ?? '' },
    calendarSync: typeof doc.overlay?.calendarSync === 'boolean' ? doc.overlay.calendarSync : null,
    plannedAt: typeof doc.overlay?.plannedAt === 'string' ? doc.overlay.plannedAt : null,
    editedAt:
      updated !== null && edited !== null
        ? new Date(Math.max(+updated, +edited))
        : (updated ?? edited),
  };
}

/**
 * The push set's items, read in two parts (see the header): every item of `linked` still in it,
 * then, page by page while `budget` keeps the writes' reserve, the others (one page at least).
 * `scope` (the access filter first) is matched on what is stored; then every item's effective
 * values are projected (Overrides: a mirrored item's overrides, so its event is placed at the date
 * it reads as), and `dated` and `narrowed` (a dry run's own stages, its compiled filter) read them.
 */
async function pushItems(
  workspaceId: string,
  scope: readonly Filter[],
  dated: readonly Filter[],
  narrowed: readonly Record<string, unknown>[],
  linked: readonly string[],
  budget: TimeBudget,
): Promise<PushItem[]> {
  const items = await getItemRepository();
  // A wider filter on what is stored before the projection (exact after it): the indexes narrow.
  const wide = Overrides.prefilter({ $and: [...dated] });
  const read = (match: Filter[], extra: Record<string, unknown>[] = []): Promise<PushDoc[]> =>
    items.aggregate<PushDoc>(workspaceId, [
      { $match: { $and: wide === null ? match : [...match, wide] } },
      { $addFields: Overrides.projection() },
      { $match: { $and: [...dated] } },
      ...narrowed,
      ...extra,
      { $project: PUSH_FIELDS },
    ]);
  const found: PushDoc[] = [];
  for (let at = 0; at < linked.length; at += PAGE_SIZE) {
    found.push(...(await read([...scope, { _id: { $in: linked.slice(at, at + PAGE_SIZE) } }])));
  }
  let after: string | null = null;
  do {
    const unlinked: Filter =
      after === null ? { _id: { $nin: [...linked] } } : { _id: { $nin: [...linked], $gt: after } };
    const page = await read([...scope, unlinked], [{ $sort: { _id: 1 } }, { $limit: PAGE_SIZE }]);
    found.push(...page);
    after = page.length < PAGE_SIZE ? null : (page.at(-1)?._id ?? null);
  } while (after !== null && budget.canStart(WRITE_RESERVE_MS));
  return found.map(toPushItem);
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

/**
 * Items to push → ops, for `integration` at `now`, into the workspace's primary calendar. 409
 * `calendar_not_primary` unless the primary calendar is on this integration; 409 when its member
 * is gone.
 */
export async function loadPlan(
  integration: IntegrationData,
  now: Date,
  narrowing?: PlanNarrowing,
  budget: TimeBudget = TimeBudget.start(WRITE_BUDGET_MS),
): Promise<LoadedPlan> {
  const { workspaceId } = integration;
  const config = readGcalConfig(integration);
  const owner = integration.ownerUserId;
  const caller = await Caller.enter(workspaceId, Actor.user(owner));
  if (caller === null) {
    throw new AppError(409, 'The member who connected this integration is gone');
  }
  const primary = WorkspaceSettings.from(caller.settings).primaryCalendar;
  if (primary?.isOn(integration.id) !== true) throw new CalendarNotPrimaryError(integration.id);
  const timeZone = caller.settings.timezone;

  const linkRepo = await getCalendarLinkRepository();
  const [allLive, stones, kept] = await Promise.all([
    linkRepo.listLive(workspaceId, integration.id),
    linkRepo.listTombstonedSince(
      workspaceId,
      integration.id,
      new Date(now.getTime() - TOMBSTONE_MS),
    ),
    linkRepo.listKeptStops(workspaceId, integration.id),
  ]);
  // Only links to events TodoList made are ever updated, moved or deleted (CalendarLink).
  const live = allLive.filter((link) => CalendarLink.isOwnLive(link));
  const recent = new Set(stones.map((link) => link.id));
  const links: PushLink[] = [...live, ...stones, ...kept.filter((link) => !recent.has(link.id))];

  // Everything its owner may see (their own, the shared integrations, the to-dos they may see).
  const policy = await ItemPolicy.for(caller);
  const window = spanOf(
    new Date(now.getTime() - PAST_WINDOW_DAYS * DAY_MS),
    new Date(now.getTime() + config.horizonDays * DAY_MS),
    timeZone,
  );
  const narrowed = narrowingOf(narrowing, caller, policy, now);
  const scope: Filter[] = [policy.itemFilter(caller.context), ...pushRule()];
  const items = await pushItems(
    workspaceId,
    scope,
    [datedWithin(window), ...narrowed.filters],
    narrowed.stages,
    live.map((link) => link.itemId),
    budget,
  );

  const cfg: PushConfig & { calendarId: string } = {
    workspaceId,
    calendarId: primary.calendarId,
    timeZone,
    horizonDays: config.horizonDays,
    maxOps: config.maxOpsPerRun,
    maxCreates: await remainingCreates(integration, now),
    // Every live link's item was read, so a delete is always right; a narrowed plan sees a part.
    allowDelete: narrowing === undefined,
  };
  return { ...buildOps(items, links, cfg, now), cfg, config };
}
