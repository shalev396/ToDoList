/**
 * seedWorkspace: the demo data of one workspace, for the dev and qa stages (Workspace.create's
 * "Load demo data", POST /private/workspaces {loadDemoData: true}). The demo's specifics are in
 * demoData.ts (D17).
 *
 * It goes through the same services a person's clicks do, acting as the workspace's owner:
 * 1. one integration per demo account (Integration.connectWithKey), on a stable account, marked
 *    `demo` (it never syncs, is never tested against its provider and is never written to: it
 *    stays read-only), with a FAKE credential (Integration#saveCredential: sealed like any other,
 *    never stored in plaintext);
 * 2. the demo area rules (`shalev396/*` → personal, `Braude*` → college);
 * 3. local to-dos (items.ts): overdue, today, later this week and undated;
 * 4. the template dashboards (dashboards.ts), published;
 * 5. one fixture sync per integration (runIntegrationSync, trigger `seed`), all at once: the items
 *    are the adapters' recorded fixtures, their relative dates resolved against `now` in the
 *    workspace's time zone, so they look exactly like a real sync's. Records without a URL are
 *    counted as the run's failures and never stored, as in any sync.
 *
 * Idempotent: what exists is found by its natural key (or its seed id) and left as it is, and the
 * syncs leave unchanged items untouched (same hash: no `updatedAt` bump). A to-do its owner
 * deleted stays deleted. Nothing here prints, logs or returns a secret.
 */
import { connectorsOf } from '../builder/connectors.js';
import { listTemplates, type TemplateLanguage } from '../builder/templates.js';
import { environment } from '../config/environment.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import type { WorkspaceSettings } from '../models/definitions/Workspace.js';
import {
  getContainerRepository,
  getCredentialRepository,
  getDashboardRepository,
  getIntegrationRepository,
  getItemRepository,
  getWorkspaceRepository,
} from '../models/index.js';
import type { WorkspaceContext } from '../services/accessFilter.js';
import {
  applyDashboardOps,
  deleteDashboard,
  instantiateDashboard,
  publishDashboard,
} from '../services/dashboards.js';
import {
  isPlaceholderAccountId,
  planConnection,
  type ConnectionInput,
} from '../services/integrationConfig.js';
import { DEFAULT_TOPIC_SLUGS, type DefaultTopicSlug } from '../types/topics.js';
import { Topic } from '../classes/workspace/Topic.js';
import { Workspace } from '../classes/workspace/Workspace.js';
import { Actor, type ActorRef } from '../classes/base/Actor.js';
import { Integration } from '../classes/integration/index.js';
import { Caller } from '../classes/base/Caller.js';
import { Todo } from '../classes/item/index.js';
import { fixtureSetDir } from '../sync/fixtureSets.js';
import type { Transport } from '../sync/http.js';
import { getAdapter } from '../sync/registry.js';
import type { Clock } from '../sync/http.js';
import { runIntegrationSync } from '../sync/runSync.js';
import { resolveOffset } from '../sync/transports/fixtureDates.js';
import { fixtureTransport, loadFixtureSet } from '../sync/transports/fixtures.js';
import type { SyncRunSummary } from '../sync/types.js';
import type { Provider } from '../types/domain.js';
import {
  DEMO_TOPIC_RULES,
  DEMO_CONNECTOR_BLOCKS,
  DEMO_DASHBOARDS,
  DEMO_INTEGRATIONS,
  DEMO_TODOS,
  type DemoDue,
  type DemoIntegration,
} from './demoData.js';
import { fakeCredential } from './fakeCredentials.js';
import { seedId } from './ids.js';
import { demoDataRefusal } from './stage.js';

export interface SeedOptions {
  /** The language of the dashboards' titles. Default: en. */
  language?: TemplateLanguage | undefined;
}

/** One demo integration after the seed. */
export interface SeededIntegration {
  /** Its name in the seed, e.g. `github-user`. */
  key: string;
  provider: Provider;
  label: string;
  integrationId: string;
  /** Its default topic's id; null: none. */
  topicId: string | null;
  /** How the seed's sync of it ended: `succeeded`, `partial` (records skipped) or `failed`. */
  status: SyncRunSummary['status'];
  /** The failed sync's error code, else null. */
  error: string | null;
  /** Its live items and containers after the sync. */
  items: number;
  containers: number;
  /** Records the sync skipped (no URL, no id, unmappable): counted, never stored. */
  failed: number;
}

export interface SeedSummary {
  workspaceId: string;
  /** In demoData.ts order. */
  integrations: SeededIntegration[];
  /** The demo to-dos still live (one its owner deleted stays deleted). */
  localTodos: number;
  /** The demo dashboards. */
  dashboards: number;
}

interface Connected {
  spec: DemoIntegration;
  integration: IntegrationData;
}

function connectionOf(spec: DemoIntegration): ConnectionInput {
  return {
    provider: spec.provider,
    config: spec.config,
    label: spec.label,
    authMethod: spec.authMethod,
  };
}

/**
 * The account the demo integration is keyed on: what its config names (a site host, a GitHub
 * owner), else a seed id. ClickUp, Linear and Google name theirs only in a connection test, and
 * a fixed one lets a later run find the integration again.
 */
function demoAccountId(spec: DemoIntegration): string {
  const planned = planConnection(connectionOf(spec)).accountId;
  return isPlaceholderAccountId(planned) ? seedId(`account/${spec.key}`) : planned;
}

/** The demo integration, found by its account (or as the seed left it unpinned), else connected. */
async function ensureIntegration(
  ctx: WorkspaceContext,
  actor: ActorRef,
  spec: DemoIntegration,
): Promise<IntegrationData> {
  const integrations = await getIntegrationRepository();
  const accountId = demoAccountId(spec);
  // The owner's own: an integration belongs to the member who connected it (PERMISSIONS-V2).
  const existing = (await integrations.listForOwner(ctx.id, actor.userId)).filter(
    (integration) => integration.provider === spec.provider,
  );
  const integration =
    existing.find((found) => found.accountId === accountId) ??
    existing.find(
      (found) => isPlaceholderAccountId(found.accountId) && found.label === spec.label,
    ) ??
    (
      await Integration.connectWithKey(Caller.fromContext(ctx, actor), connectionOf(spec), {
        demo: true,
      })
    ).toJSON();
  if (integration.accountId === accountId) return integration;
  const pinned = await integrations.replacePendingAccount(ctx.id, integration.id, accountId);
  if (pinned === null) throw new Error(`seedWorkspace: could not set the ${spec.key} account`);
  return pinned;
}

/** A FAKE credential, through the credential PUT's service, unless the integration has one. */
async function ensureCredential(
  ctx: WorkspaceContext,
  actor: ActorRef,
  { spec, integration }: Connected,
): Promise<void> {
  const credentials = await getCredentialRepository();
  if ((await credentials.findMeta(ctx.id, integration.id)) !== null) return;
  const caller = Caller.fromContext(ctx, actor);
  await (
    await Integration.findOwn(caller, integration.id)
  ).saveCredential(caller, fakeCredential(spec.authMethod, spec.key));
}

/** The ids of the workspace's default topics, by slug (the seed makes sure all three exist). */
type TopicIds = Readonly<Record<DefaultTopicSlug, string>>;

/** Appends the demo topic rules the workspace lacks (compared without case). */
async function ensureTopicRules(
  ctx: WorkspaceContext,
  actorUserId: string,
  topics: TopicIds,
): Promise<void> {
  const caller = Caller.fromContext(ctx, Actor.user(actorUserId));
  const workspace = await Workspace.load(caller);
  const rules = workspace.settings.topicRules.toJSON();
  const missing = DEMO_TOPIC_RULES.filter(
    (rule) => !rules.some((have) => have.match.toLowerCase() === rule.match.toLowerCase()),
  ).map((rule) => ({ match: rule.match, topicId: topics[rule.topic] }));
  if (missing.length === 0) return;
  await workspace.update(caller, { settings: { topicRules: [...rules, ...missing] } });
}

const WEEKDAYS = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

/** Days after today, in the workspace's zone, that are still in this week (0 on its last day). */
function daysLeftInWeek(now: Date, settings: WorkspaceSettings): number {
  const weekday = new Intl.DateTimeFormat('en-US', {
    timeZone: settings.timezone,
    weekday: 'short',
  }).format(now);
  const firstDay = settings.weekStart === 'mon' ? 1 : 0;
  return 6 - ((WEEKDAYS.indexOf(weekday) - firstDay + 7) % 7);
}

/** The end (23:59 local) of the day a demo to-do is due, or null. */
function dueAt(due: DemoDue, now: Date, settings: WorkspaceSettings): Date | null {
  if (due === null) return null;
  const days = due === 'later_this_week' ? Math.min(2, daysLeftInWeek(now, settings)) : due.days;
  const offset = `${days < 0 ? '-' : '+'}${String(Math.abs(days))}d@23:59`;
  return resolveOffset(offset, now, settings.timezone);
}

/**
 * The demo to-dos, created by the owner with an idempotency key each (its seed id). Returns the
 * keys. One that exists, even deleted, is left as its owner left it.
 */
async function ensureTodos(
  ctx: WorkspaceContext,
  ownerId: string,
  now: Date,
  topics: TopicIds,
): Promise<string[]> {
  const items = await getItemRepository();
  const keys: string[] = [];
  for (const todo of DEMO_TODOS) {
    const idempotencyKey = seedId(todo.name);
    keys.push(idempotencyKey);
    const [existing] = await items.aggregate(ctx.id, [
      { $match: { ownerUserId: ownerId, 'props.idempotencyKey': idempotencyKey } },
      { $limit: 1 },
    ]);
    if (existing !== undefined) continue;
    await Todo.create(Caller.fromContext(ctx, Actor.user(ownerId)), {
      title: todo.title,
      topicId: topics[todo.topic],
      dueAt: dueAt(todo.due, now, ctx.settings),
      ...(todo.priority === undefined ? {} : { priority: todo.priority }),
      ...(todo.note === undefined ? {} : { note: todo.note }),
      idempotencyKey,
    });
  }
  return keys;
}

/**
 * A new workspace without sample data starts minimal (D1): the Personal topic and one empty
 * Personal page. The demo wants all three default topics and its own template pages, so the
 * missing topics are added and that empty page, if nobody has put anything on it, is deleted (its
 * template page replaces it). Answers the default topics' ids.
 */
async function leaveMinimalShape(
  ctx: WorkspaceContext,
  actor: ActorRef,
  language: TemplateLanguage,
): Promise<TopicIds> {
  const all = await Topic.ensureDefaults(ctx.id, DEFAULT_TOPIC_SLUGS, language);
  const idOf = (slug: DefaultTopicSlug): string => {
    const topic = all.find((entry) => entry.slug === slug);
    if (topic === undefined) throw new Error(`seedWorkspace: no ${slug} topic`);
    return topic.id;
  };
  const topics: TopicIds = {
    work: idOf('work'),
    college: idOf('college'),
    personal: idOf('personal'),
  };
  const empty = (await (await getDashboardRepository()).list(ctx.id, {})).filter(
    (dashboard) =>
      dashboard.templateKey === null &&
      dashboard.scope.topicId === topics.personal &&
      dashboard.scope.page === 'topic' &&
      dashboard.blocks.length === 0 &&
      dashboard.version === 1,
  );
  for (const dashboard of empty) {
    await deleteDashboard(ctx, { userId: actor.userId, agentId: actor.agentId }, dashboard.id);
  }
  return topics;
}

/** The demo dashboards from their templates (published: the owner creates them). */
async function ensureDashboards(
  ctx: WorkspaceContext,
  actor: ActorRef,
  language: TemplateLanguage,
  topics: TopicIds,
): Promise<number> {
  const existing = await (await getDashboardRepository()).list(ctx.id, {});
  const templates = new Map(listTemplates().map((template) => [template.key, template]));
  for (const demo of DEMO_DASHBOARDS) {
    const template = templates.get(demo.templateKey);
    if (template === undefined) throw new Error(`seedWorkspace: no template ${demo.templateKey}`);
    const topicId = demo.topic === undefined ? null : topics[demo.topic];
    const found = existing.some(
      (dashboard) =>
        dashboard.templateKey === template.key &&
        dashboard.scope.topicId === topicId &&
        dashboard.scope.page === template.scope.page,
    );
    if (found) continue;
    await instantiateDashboard(ctx, actor, {
      templateKey: template.key,
      language,
      ...(topicId === null ? {} : { scope: { topicId } }),
    });
  }
  return DEMO_DASHBOARDS.length;
}

/**
 * The connector blocks (DEMO_CONNECTOR_BLOCKS): a list reading only the chosen integrations (its
 * connectors), added to a template dashboard and published with it. Skipped when the dashboard
 * already has a block with exactly those connectors, so a second run changes nothing.
 */
async function ensureConnectorBlocks(
  ctx: WorkspaceContext,
  actor: ActorRef,
  connected: readonly Connected[],
  language: TemplateLanguage,
): Promise<void> {
  const dashboards = await getDashboardRepository();
  for (const demo of DEMO_CONNECTOR_BLOCKS) {
    const target = (await dashboards.list(ctx.id, {})).find(
      (dashboard) => dashboard.templateKey === demo.templateKey,
    );
    if (target === undefined) throw new Error(`seedWorkspace: no ${demo.templateKey} dashboard`);
    const ids = demo.connectors.map((key) => {
      const found = connected.find(({ spec }) => spec.key === key);
      if (found === undefined) throw new Error(`seedWorkspace: no demo integration ${key}`);
      return found.integration.id;
    });
    const same = JSON.stringify(ids);
    if (target.blocks.some((block) => JSON.stringify(connectorsOf(block)) === same)) continue;
    // Full width, below everything else: a task list with chips needs the room.
    const below = (items: readonly unknown[]): number =>
      items.reduce<number>((bottom, raw) => {
        const item = raw as { y: number; h: number };
        return Math.max(bottom, item.y + item.h);
      }, 0);
    const result = await applyDashboardOps(ctx, actor, target.id, {
      expectedVersion: target.version,
      language,
      ops: [
        {
          op: 'add_block',
          layout: {
            lg: { x: 0, y: below(target.layouts.lg), w: 12, h: 10 },
            md: { x: 0, y: below(target.layouts.md), w: 8, h: 10 },
          },
          block: {
            type: 'list',
            title: demo.titles[language],
            connectors: ids,
            query: {
              source: 'items',
              sort: [
                { field: 'status', dir: 'asc' },
                { field: 'dueAt', dir: 'asc' },
              ],
              limit: 50,
            },
          },
        },
      ],
    });
    if (!('version' in result)) throw new Error('seedWorkspace: the connector block was not saved');
    await publishDashboard(ctx, actor, target.id, { expectedVersion: result.version });
  }
}

/**
 * The adapter's fixture set with its relative dates resolved against `now` in the workspace's
 * zone (the engine's own replay uses the wall clock in Asia/Jerusalem). Null when there is no such
 * adapter or set: the engine then records the run as `no_adapter` or `fixtures_missing`.
 */
async function fixtureReplay(
  provider: Provider,
  set: string,
  now: Date,
  timeZone: string,
): Promise<Transport | null> {
  const adapter = getAdapter(provider);
  if (adapter === null) return null;
  try {
    return fixtureTransport(await loadFixtureSet(fixtureSetDir(adapter, set)), { now, timeZone });
  } catch {
    return null;
  }
}

/** A clock whose waits return at once: the seed replays fixtures, so no provider needs sparing. */
const noWaitClock: Clock = {
  now: () => Date.now(),
  sleep: () => Promise.resolve(),
};

/** One fixture sync per integration, all at once (different integrations share nothing). */
async function syncAll(
  connected: readonly Connected[],
  now: Date,
  timeZone: string,
): Promise<SyncRunSummary[]> {
  const settled = await Promise.allSettled(
    connected.map(async ({ spec, integration }) => {
      const transport = await fixtureReplay(integration.provider, spec.fixtureSet, now, timeZone);
      return runIntegrationSync(integration.id, {
        trigger: 'seed',
        mode: 'fixtures',
        fixtureSet: spec.fixtureSet,
        now,
        // Fixture replays never wait on a provider's request throttle (Moodle: 1 s per request).
        clock: noWaitClock,
        ...(transport === null ? {} : { transport }),
      });
    }),
  );
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

async function summarize(
  ctx: WorkspaceContext,
  ownerId: string,
  connected: readonly Connected[],
  runs: readonly SyncRunSummary[],
  todoKeys: readonly string[],
  dashboards: number,
): Promise<SeedSummary> {
  const items = await getItemRepository();
  const containers = await getContainerRepository();
  const count = async (match: Record<string, unknown>): Promise<number> => {
    const [row] = await items.aggregate<{ n: number }>(ctx.id, [
      { $match: { ...match, deletedAt: null } },
      { $count: 'n' },
    ]);
    return row?.n ?? 0;
  };
  const integrations: SeededIntegration[] = [];
  for (const [index, { spec, integration }] of connected.entries()) {
    const run = runs[index];
    if (run === undefined) throw new Error('seedWorkspace: a sync result is missing');
    integrations.push({
      key: spec.key,
      provider: integration.provider,
      label: integration.label,
      integrationId: integration.id,
      topicId: integration.topicId,
      status: run.status,
      error: run.error?.code ?? null,
      items: await count({ integrationId: integration.id }),
      containers: (await containers.list(ctx.id, { integrationId: integration.id })).length,
      failed: run.counts.failed,
    });
  }
  return {
    workspaceId: ctx.id,
    integrations,
    localTodos: await count({ ownerUserId: ownerId, 'props.idempotencyKey': { $in: todoKeys } }),
    dashboards,
  };
}

/**
 * Fills the workspace with the demo data, as its owner. See the file header. Throws on any
 * stage but dev and qa, whoever calls it: FAKE integrations never reach a prod workspace.
 */
export async function seedWorkspace(
  workspaceId: string,
  now: Date,
  options: SeedOptions = {},
): Promise<SeedSummary> {
  const refusal = demoDataRefusal(environment.env);
  if (refusal !== null) throw new Error(refusal);
  const workspace = await (await getWorkspaceRepository()).findById(workspaceId);
  if (workspace === null) throw new Error('seedWorkspace: no such workspace');
  const first = (await Caller.enter(workspaceId, Actor.user(workspace.ownerId)))?.context;
  if (first?.role !== 'owner') throw new Error('seedWorkspace: the workspace has no owner');
  const actor: ActorRef = { userId: workspace.ownerId, agentId: null };

  const topics = await leaveMinimalShape(first, actor, options.language ?? 'en');
  // Read again: the context carries the settings.
  const ctx = (await Caller.enter(workspaceId, Actor.user(workspace.ownerId)))?.context;
  if (ctx?.role !== 'owner') throw new Error('seedWorkspace: the workspace has no owner');
  const connected: Connected[] = [];
  for (const spec of DEMO_INTEGRATIONS) {
    const integration = await ensureIntegration(ctx, actor, spec);
    await ensureCredential(ctx, actor, { spec, integration });
    connected.push({ spec, integration });
  }
  await ensureTopicRules(ctx, actor.userId, topics);
  const todoKeys = await ensureTodos(ctx, actor.userId, now, topics);
  const dashboards = await ensureDashboards(ctx, actor, options.language ?? 'en', topics);
  await ensureConnectorBlocks(ctx, actor, connected, options.language ?? 'en');
  const runs = await syncAll(connected, now, ctx.settings.timezone);
  return summarize(ctx, actor.userId, connected, runs, todoKeys, dashboards);
}
