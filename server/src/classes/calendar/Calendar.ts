/**
 * One target Google calendar of a workspace (plan Addendum A2): the workspace's primary calendar,
 * as the Google Calendar integration it is on pushes to it. It composes its links (CalendarLink,
 * tombstones included), its pull cursor (SyncCursor, `gcal:<id>`) and what a push would do
 * (PushPlan). GoogleCalendarIntegration uses it to plan, push and commit; the diff (gcal/diff.ts)
 * and the Calendar API (writers/calendarApi.ts) stay pure.
 *
 * The push set is fixed, and read as one MongoDB filter over what the integration's owner may see
 * (ItemPolicy as them: their own integrations, the shared ones, and the to-dos they may see,
 * never another member's private one): every item dated within the push window (a planned date
 * `overlay.plannedAt`, a due date, or a start whose span reaches into it), except the items Google
 * Calendar itself mirrors (they are its events already) and those with `overlay.calendarSync ===
 * false`. A provider copy of a local to-do is left out while its to-do is in the set, or turned off
 * for the calendar (H5, absorbedCopies). It is read in two parts, so no cap ever hides an item:
 * - the items of the live links, all of them (in chunks): what to update or move, and, by their
 *   absence, which events to delete;
 * - the other items, page by page while the request's budget keeps WRITE_RESERVE_MS for the
 *   writes (a push plans and writes within one TimeBudget): what to create. One cut short only
 *   defers creates; the next run reads them first, since what was created is linked.
 * Then the recently tombstoned links, and what is left of the daily creation cap.
 */
import { Actor } from '../base/Actor.js';
import { Caller } from '../base/Caller.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { TimeBudget, WRITE_BUDGET_MS } from '../integration/calendar/TimeBudget.js';
import { Overrides } from '../item/Overrides.js';
import { ItemAccessFilter } from '../policies/ItemAccessFilter.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import type { SyncCursor } from '../sync/SyncCursor.js';
import { SyncCursors } from '../sync/SyncCursors.js';
import { SyncRun } from '../sync/SyncRun.js';
import { AttributeDefinitions } from '../workspace/AttributeDefinitions.js';
import { WorkspaceSettings } from '../workspace/WorkspaceSettings.js';
import { compileQuery, parseQuery } from '../../builder/compile.js';
import { AppError } from '../../errors/AppError.js';
import { CalendarNotPrimaryError } from '../../errors/CalendarNotPrimaryError.js';
import {
  buildOps,
  localDate,
  PAST_WINDOW_DAYS,
  TOMBSTONE_MS,
  type PushConfig,
  type PushItem,
  type PushLink,
} from '../../gcal/diff.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { getCalendarLinkRepository, getItemRepository } from '../../models/index.js';
import { redactString } from '../../services/secretPatterns.js';
import { zonedTime } from '../../sync/transports/fixtureDates.js';
import { SCHEDULED_KINDS } from '../../types/domain.js';
import { CalendarLink } from './CalendarLink.js';
import { PushCommit, type CommitCounts } from './PushCommit.js';
import { PushPlan, readGcalConfig, type PlanNarrowing } from './PushPlan.js';

/** Google allows 5,000 creations a day; we stop at 4,000. */
export const DAILY_CREATE_CAP = 4000;
/** What the plan leaves of the request's budget for the writes and the pull that follow. */
export const WRITE_RESERVE_MS = 12_000;
/** Items read per page (and link items per chunk). */
const PAGE_SIZE = 500;
const DAY_MS = 24 * 60 * 60 * 1000;

type Filter = Record<string, unknown>;

/** A calendar as this class holds it: Google's id, and the integration that pushes to it. */
export interface CalendarData {
  /** Google's calendar id (from calendarList: never the `primary` alias). */
  id: string;
  workspaceId: string;
  integrationId: string;
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
 * The push set's own rules on what the sync stores: not Google Calendar's, not turned off, and
 * not TodoList's own reserved time (time blocks, areas and travel legs stay out of the workspace
 * calendar in this version, whatever their `calendarSync`: Ruling 26). Being dated in the window
 * (datedWithin) is checked on the effective values, after the projection.
 */
function pushRule(): Filter[] {
  return [
    { 'source.provider': { $ne: 'google_calendar' } },
    { 'overlay.calendarSync': { $ne: false } },
    { kind: { $nin: [...SCHEDULED_KINDS] } },
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
    // the query's own work (computed fields, then its filters). Not its copy absorption: the push
    // set is read in pages, and absorbedCopies applies H5 to the whole set.
    const facet = compiled.pipeline.findIndex((stage) => '$facet' in stage);
    narrowed.stages = compiled.pipeline
      .slice(1, facet === -1 ? undefined : facet)
      .filter((stage) => !ItemAccessFilter.isCopyAbsorption(stage));
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

type PushRead = (match: Filter[], extra?: Record<string, unknown>[]) => Promise<PushDoc[]>;

/**
 * H5 in the push set: a provider copy is left out while its to-do is in the set, and while its
 * to-do is turned off for the calendar (the copy is the same task: no event he turned off comes
 * back through it); any other copy is pushed as its own item. The set is read in pages, so the
 * to-dos are found first, among the ones the copies in `scope` name (few), through the same read,
 * and the copies are then left out of every page. `{}` when no copy is left out.
 */
async function absorbedCopies(
  workspaceId: string,
  access: Filter,
  scope: readonly Filter[],
  read: PushRead,
): Promise<Filter> {
  const items = await getItemRepository();
  const named = await items.aggregate<{ _id?: unknown }>(workspaceId, [
    { $match: { $and: [...scope, { 'overlay.copyOf': { $type: 'string' } }] } },
    { $group: { _id: '$overlay.copyOf' } },
  ]);
  const todoIds = named.flatMap((row) => (typeof row._id === 'string' ? [row._id] : []));
  if (todoIds.length === 0) return {};
  const [inSet, offCalendar] = await Promise.all([
    read([...scope, { _id: { $in: todoIds } }]),
    items.aggregate<{ _id: string }>(workspaceId, [
      { $match: { $and: [access, { _id: { $in: todoIds }, 'overlay.calendarSync': false }] } },
      { $project: { _id: 1 } },
    ]),
  ]);
  const todos = [...new Set([...inSet, ...offCalendar].map((doc) => doc._id))];
  return todos.length === 0 ? {} : { 'overlay.copyOf': { $nin: todos } };
}

/**
 * The push set's items, read in two parts (see the header): every item of `linked` still in it,
 * then, page by page while `budget` keeps the writes' reserve, the others (one page at least).
 * The access filter and the push rules are matched on what is stored; then every item's effective
 * values are projected (Overrides: a mirrored item's overrides, so its event is placed at the date
 * it reads as), and `dated` and `narrowed` (a dry run's own stages, its compiled filter) read them.
 * A provider copy whose to-do is in the set is left out (absorbedCopies).
 */
async function pushItems(
  workspaceId: string,
  access: Filter,
  dated: readonly Filter[],
  narrowed: readonly Record<string, unknown>[],
  linked: readonly string[],
  budget: TimeBudget,
): Promise<PushItem[]> {
  const items = await getItemRepository();
  // A wider filter on what is stored before the projection (exact after it): the indexes narrow.
  const wide = Overrides.prefilter({ $and: [...dated] });
  const read: PushRead = (match, extra = []) =>
    items.aggregate<PushDoc>(workspaceId, [
      { $match: { $and: wide === null ? match : [...match, wide] } },
      { $addFields: Overrides.projection() },
      { $match: { $and: [...dated] } },
      ...narrowed,
      ...extra,
      { $project: PUSH_FIELDS },
    ]);
  const pushed: Filter[] = [access, ...pushRule()];
  const absorbed = await absorbedCopies(workspaceId, access, pushed, read);
  const scope = Object.keys(absorbed).length === 0 ? pushed : [...pushed, absorbed];
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

export class Calendar extends WorkspaceEntity<CalendarData> {
  readonly #integration: IntegrationData;

  protected constructor(integration: IntegrationData, calendarId: string) {
    super({ id: calendarId, workspaceId: integration.workspaceId, integrationId: integration.id });
    this.#integration = integration;
  }

  /**
   * The calendar a push of `integration` wrote to (its commit's calendar): no check, the push
   * already planned it as the primary calendar. It commits and pulls; it does not plan.
   */
  static of(integration: IntegrationData, calendarId: string): Calendar {
    return new Calendar(integration, calendarId);
  }

  /**
   * The workspace's primary calendar, as `integration` pushes to it (PushCalendar, the one kind
   * that plans): 409 `calendar_not_primary` unless the primary calendar is on this integration;
   * 409 when its member is gone.
   */
  static primaryFor(integration: IntegrationData): Promise<PushCalendar> {
    return PushCalendar.primaryFor(integration);
  }

  get integrationId(): string {
    return this.data.integrationId;
  }

  /** The integration that pushes to it. */
  protected get integration(): IntegrationData {
    return this.#integration;
  }

  /** Where the pull after a push stands on this calendar (`gcal:<id>`, apart from the sync's). */
  async cursor(): Promise<SyncCursor> {
    return SyncCursors.of(this.#integration).get(`gcal:${this.id}`);
  }

  /**
   * One push's commit into this calendar (PushCommit): the op results (links, audit), the pull's
   * Google changes, and the run's end. Throws 409 for a run that is not open.
   */
  commit(input: unknown, now: Date = new Date()): Promise<CommitCounts> {
    return PushCommit.apply(this.#integration, input, now, this.id);
  }
}

/**
 * The workspace's primary calendar as the integration it is on pushes to it: a Calendar that also
 * plans, as that integration's owner (whose caller it holds, so a plan can never run for nobody).
 */
export class PushCalendar extends Calendar {
  /** The integration's owner, as whom the push set is read. */
  readonly #owner: Caller;

  private constructor(integration: IntegrationData, calendarId: string, owner: Caller) {
    super(integration, calendarId);
    this.#owner = owner;
  }

  /**
   * The workspace's primary calendar, as `integration` pushes to it: 409 `calendar_not_primary`
   * unless the primary calendar is on this integration; 409 when its member is gone.
   */
  static override async primaryFor(integration: IntegrationData): Promise<PushCalendar> {
    const owner = await Caller.enter(integration.workspaceId, Actor.user(integration.ownerUserId));
    if (owner === null) {
      throw new AppError(409, 'The member who connected this integration is gone');
    }
    const primary = WorkspaceSettings.from(owner.settings).primaryCalendar;
    if (primary?.isOn(integration.id) !== true) throw new CalendarNotPrimaryError(integration.id);
    return new PushCalendar(integration, primary.calendarId, owner);
  }

  /**
   * Items to push → ops, at `now`, into this primary calendar, as its integration's owner sees
   * them. A narrowing (the MCP dry run) plans some items and deletes
   * nothing. The plan spends part of `budget`, which the writes and the pull then share.
   */
  async plan(
    now: Date,
    narrowing?: PlanNarrowing,
    budget: TimeBudget = TimeBudget.start(WRITE_BUDGET_MS),
  ): Promise<PushPlan> {
    const integration = this.integration;
    const { workspaceId } = integration;
    const config = readGcalConfig(integration);
    const caller = this.#owner;
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
    const items = await pushItems(
      workspaceId,
      policy.itemFilter(caller.context),
      [datedWithin(window), ...narrowed.filters],
      narrowed.stages,
      live.map((link) => link.itemId),
      budget,
    );

    const cfg: PushConfig & { calendarId: string } = {
      workspaceId,
      calendarId: this.id,
      timeZone,
      horizonDays: config.horizonDays,
      maxOps: config.maxOpsPerRun,
      maxCreates: await this.#remainingCreates(now),
      // Every live link's item was read, so a delete is always right; a narrowed plan sees a part.
      allowDelete: narrowing === undefined,
    };
    return PushPlan.of({ ...buildOps(items, links, cfg, now), cfg, config });
  }

  /** Creations still allowed today: the cap minus what runs of the last 24 hours created. */
  async #remainingCreates(now: Date): Promise<number> {
    const runs = await SyncRun.listFor(this.integration, 100);
    let used = 0;
    for (const run of runs) {
      const push = run.trigger === 'calendar_push';
      if (push && now.getTime() - run.startedAt.getTime() < DAY_MS) {
        used += run.counts['created'] ?? 0;
      }
    }
    return Math.max(0, DAILY_CREATE_CAP - used);
  }
}
