/**
 * seedWorkspace: the demo data of one workspace, for the dev and qa stages (Workspace.create's
 * "Load demo data", POST /private/workspaces {loadDemoData: true}). The demo's specifics are in
 * demoData.ts (D17).
 *
 * It goes through the same classes a person's clicks do, acting as the workspace's owner, and
 * reaches the database only through them:
 * 1. one integration per demo account (Integration.connectWithKey), on a stable account
 *    (Integration#pinAccount), marked `demo` (it never syncs, is never tested against its provider
 *    and is never written to: it stays read-only), with a FAKE credential
 *    (Integration#saveCredential: sealed like any other, never stored in plaintext);
 * 2. the demo area rules (`shalev396/*` → personal, `Braude*` → college);
 * 3. local to-dos (Todo.create): overdue, today, later this week and undated;
 * 4. the template dashboards (Dashboard.instantiate), published; what exists is found by its
 *    outline (Dashboard.listOutlines);
 * 5. one fixture sync per integration (Integration.runSync, trigger `seed`), all at once: the items
 *    are the adapters' recorded fixtures, their relative dates resolved against `now` in the
 *    workspace's time zone, so they look exactly like a real sync's. Records without a URL are
 *    counted as the run's failures and never stored, as in any sync.
 *
 * Steps that don't depend on each other run at once, since every query is a round trip to the
 * database (from a local API to a stage's, a long one): 1 (each provider's accounts in demo order,
 * the providers at once), 2 and 3 together; then 4 (each topic's pages in template order, the
 * topics at once) beside 5. A step that fails is waited out with the rest, so nothing is still
 * writing when the seed throws. What lists in creation order (one provider's connections, one
 * topic's pages) is still made in demo order.
 *
 * Idempotent: what exists is found by its natural key (or its seed id) and left as it is, and the
 * syncs leave unchanged items untouched (same hash: no `updatedAt` bump). A to-do its owner
 * deleted stays deleted. Nothing here prints, logs or returns a secret.
 */
import { listTemplates, type TemplateLanguage } from '../builder/templates.js';
import { environment } from '../config/environment.js';
import type { WorkspaceSettings } from '../models/definitions/Workspace.js';
import {
  isPlaceholderAccountId,
  planConnection,
  type ConnectionInput,
} from '../services/integrationConfig.js';
import { DEFAULT_TOPIC_SLUGS, type DefaultTopicSlug } from '../types/topics.js';
import { Topic } from '../classes/workspace/Topic.js';
import { Workspace } from '../classes/workspace/Workspace.js';
import { Actor } from '../classes/base/Actor.js';
import { Integration } from '../classes/integration/index.js';
import { Caller } from '../classes/base/Caller.js';
import { Container, Item, Todo } from '../classes/item/index.js';
import { Dashboard } from '../classes/dashboard/index.js';
import { fixtureSetDir } from '../sync/fixtureSets.js';
import type { Transport } from '../sync/http.js';
import { getAdapter } from '../sync/registry.js';
import type { Clock } from '../sync/http.js';
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
  integration: Integration;
}

/**
 * Waits for every task to end, so none is left running behind a failure; then answers their
 * results in order, or throws the first failure.
 */
async function allOrFirstFailure<T>(tasks: readonly Promise<T>[]): Promise<T[]> {
  const settled = await Promise.allSettled(tasks);
  return settled.map((result) => {
    if (result.status === 'rejected') throw result.reason;
    return result.value;
  });
}

/**
 * `task` for every entry at once, except that entries with the same key run one after another, in
 * their order (one provider's connections, one topic's pages: they list in creation order).
 * Answers in the entries' order, as allOrFirstFailure does.
 */
async function inOrderPerKey<T, R>(
  entries: readonly T[],
  keyOf: (entry: T) => string,
  task: (entry: T) => Promise<R>,
): Promise<R[]> {
  const tails = new Map<string, Promise<unknown>>();
  const runs = entries.map((entry) => {
    const key = keyOf(entry);
    const run = (tails.get(key) ?? Promise.resolve()).then(() => task(entry));
    tails.set(key, run);
    return run;
  });
  return allOrFirstFailure(runs);
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
async function ensureIntegration(caller: Caller, spec: DemoIntegration): Promise<Integration> {
  const accountId = demoAccountId(spec);
  // The owner's own: an integration belongs to the member who connected it (PERMISSIONS-V2).
  const existing = (await Integration.listOwn(caller)).filter(
    (integration) => integration.provider === spec.provider,
  );
  const integration =
    existing.find((found) => found.accountId === accountId) ??
    existing.find(
      (found) => isPlaceholderAccountId(found.accountId) && found.label === spec.label,
    ) ??
    (await Integration.connectWithKey(caller, connectionOf(spec), { demo: true }));
  if (integration.accountId === accountId) return integration;
  const pinned = await integration.pinAccount(accountId);
  if (pinned === null) throw new Error(`seedWorkspace: could not set the ${spec.key} account`);
  return pinned;
}

/** A FAKE credential, through the credential PUT's class, unless the integration has one. */
async function ensureCredential(caller: Caller, { spec, integration }: Connected): Promise<void> {
  if (await integration.hasCredential()) return;
  await (
    await Integration.findOwn(caller, integration.id)
  ).saveCredential(caller, fakeCredential(spec.authMethod, spec.key));
}

/**
 * Every demo integration, in demoData.ts order, each with its credential. The providers connect at
 * once; one provider's accounts connect in demo order, as its cards list them by creation.
 */
async function ensureIntegrations(caller: Caller): Promise<Connected[]> {
  const connected = await inOrderPerKey(
    DEMO_INTEGRATIONS,
    (spec) => spec.provider,
    async (spec): Promise<Connected> => ({
      spec,
      integration: await ensureIntegration(caller, spec),
    }),
  );
  await allOrFirstFailure(connected.map((entry) => ensureCredential(caller, entry)));
  return connected;
}

/** The ids of the workspace's default topics, by slug (the seed makes sure all three exist). */
type TopicIds = Readonly<Record<DefaultTopicSlug, string>>;

/** Appends the demo topic rules the workspace lacks (compared without case). */
async function ensureTopicRules(caller: Caller, topics: TopicIds): Promise<void> {
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
async function ensureTodos(caller: Caller, now: Date, topics: TopicIds): Promise<string[]> {
  const keys: string[] = [];
  for (const todo of DEMO_TODOS) {
    const idempotencyKey = seedId(todo.name);
    keys.push(idempotencyKey);
    if (await Todo.existsWithKey(caller, idempotencyKey)) continue;
    await Todo.create(caller, {
      title: todo.title,
      topicId: topics[todo.topic],
      dueAt: dueAt(todo.due, now, caller.settings),
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
async function leaveMinimalShape(caller: Caller, language: TemplateLanguage): Promise<TopicIds> {
  const all = await Topic.ensureDefaults(caller.workspaceId, DEFAULT_TOPIC_SLUGS, language);
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
  const empty = (await Dashboard.listOutlines(caller)).filter(
    (dashboard) =>
      dashboard.templateKey === null &&
      dashboard.scope.topicId === topics.personal &&
      dashboard.scope.page === 'topic' &&
      dashboard.blockCount === 0 &&
      dashboard.version === 1,
  );
  for (const dashboard of empty) {
    await (await Dashboard.load(caller, dashboard.id, Dashboard.Operation.delete)).delete(caller);
  }
  return topics;
}

/**
 * The demo dashboards from their templates (published: the owner creates them). The topics' pages
 * are made at once; one topic's in demo order, as its pages list by creation.
 */
async function ensureDashboards(
  caller: Caller,
  language: TemplateLanguage,
  topics: TopicIds,
): Promise<number> {
  const existing = await Dashboard.listOutlines(caller);
  const templates = new Map(listTemplates().map((template) => [template.key, template]));
  await inOrderPerKey(
    DEMO_DASHBOARDS,
    (demo) => demo.topic ?? 'main',
    async (demo): Promise<void> => {
      const template = templates.get(demo.templateKey);
      if (template === undefined) throw new Error(`seedWorkspace: no template ${demo.templateKey}`);
      const topicId = demo.topic === undefined ? null : topics[demo.topic];
      const found = existing.some(
        (dashboard) =>
          dashboard.templateKey === template.key &&
          dashboard.scope.topicId === topicId &&
          dashboard.scope.page === template.scope.page,
      );
      if (found) return;
      await Dashboard.instantiate(caller, {
        templateKey: template.key,
        language,
        ...(topicId === null ? {} : { scope: { topicId } }),
      });
    },
  );
  return DEMO_DASHBOARDS.length;
}

/**
 * The connector blocks (DEMO_CONNECTOR_BLOCKS): a list reading only the chosen integrations (its
 * connectors), added to a template dashboard and published with it. Skipped when the dashboard
 * already has a block with exactly those connectors, so a second run changes nothing.
 */
async function ensureConnectorBlocks(
  caller: Caller,
  connected: readonly Connected[],
  language: TemplateLanguage,
): Promise<void> {
  for (const demo of DEMO_CONNECTOR_BLOCKS) {
    const target = (await Dashboard.listOutlines(caller)).find(
      (dashboard) => dashboard.templateKey === demo.templateKey,
    );
    if (target === undefined) throw new Error(`seedWorkspace: no ${demo.templateKey} dashboard`);
    const ids = demo.connectors.map((key) => {
      const found = connected.find(({ spec }) => spec.key === key);
      if (found === undefined) throw new Error(`seedWorkspace: no demo integration ${key}`);
      return found.integration.id;
    });
    const same = JSON.stringify(ids);
    if (target.connectorSets.some((set) => JSON.stringify(set) === same)) continue;
    // Full width, below everything else: a task list with chips needs the room.
    const editable = await Dashboard.load(caller, target.id, Dashboard.Operation.edit);
    const result = await editable.applyOps(caller, {
      expectedVersion: target.version,
      language,
      ops: [
        {
          op: 'add_block',
          layout: {
            lg: { x: 0, y: target.layout.bottom('lg'), w: 12, h: 10 },
            md: { x: 0, y: target.layout.bottom('md'), w: 8, h: 10 },
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
    const written = await Dashboard.load(caller, target.id, Dashboard.Operation.publish);
    await written.publish(caller, { expectedVersion: result.version });
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
  return allOrFirstFailure(
    connected.map(async ({ spec, integration }) => {
      const transport = await fixtureReplay(integration.provider, spec.fixtureSet, now, timeZone);
      return Integration.runSync(integration.id, {
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
}

async function summarize(
  caller: Caller,
  connected: readonly Connected[],
  runs: readonly SyncRunSummary[],
  todoKeys: readonly string[],
  dashboards: number,
): Promise<SeedSummary> {
  const { workspaceId } = caller;
  const counted = Promise.all(
    connected.map(async ({ spec, integration }, index): Promise<SeededIntegration> => {
      const run = runs[index];
      if (run === undefined) throw new Error('seedWorkspace: a sync result is missing');
      const [items, containers] = await Promise.all([
        Item.countLiveOf(workspaceId, integration.id),
        Container.countLiveOf(workspaceId, integration.id),
      ]);
      return {
        key: spec.key,
        provider: integration.provider,
        label: integration.label,
        integrationId: integration.id,
        topicId: integration.topicId,
        status: run.status,
        error: run.error?.code ?? null,
        items,
        containers,
        failed: run.counts.failed,
      };
    }),
  );
  const [integrations, localTodos] = await Promise.all([
    counted,
    Todo.countLiveWithKeys(caller, todoKeys),
  ]);
  return { workspaceId, integrations, localTodos, dashboards };
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
  const ownerId = await Workspace.ownerOf(workspaceId);
  if (ownerId === null) throw new Error('seedWorkspace: no such workspace');
  const first = await Caller.enter(workspaceId, Actor.user(ownerId));
  if (first?.role.name !== 'owner') {
    throw new Error('seedWorkspace: the workspace has no owner');
  }

  const language = options.language ?? 'en';
  const topics = await leaveMinimalShape(first, language);
  // Read again: the caller carries the settings.
  const caller = await Caller.enter(workspaceId, Actor.user(ownerId));
  if (caller?.role.name !== 'owner') {
    throw new Error('seedWorkspace: the workspace has no owner');
  }
  // Steps 1 to 3 need only the topics.
  const integrationsDone = ensureIntegrations(caller);
  const rulesDone = ensureTopicRules(caller, topics);
  const todosDone = ensureTodos(caller, now, topics);
  await Promise.allSettled([integrationsDone, rulesDone, todosDone]);
  const connected = await integrationsDone;
  await rulesDone;
  const todoKeys = await todosDone;
  // The dashboards bind the owner's integrations, and the syncs file by the topic rules; neither
  // reads what the other writes.
  const dashboardsDone = ensureDashboards(caller, language, topics).then(async (count) => {
    await ensureConnectorBlocks(caller, connected, language);
    return count;
  });
  const runsDone = syncAll(connected, now, caller.settings.timezone);
  await Promise.allSettled([dashboardsDone, runsDone]);
  const dashboards = await dashboardsDone;
  const runs = await runsDone;
  return summarize(caller, connected, runs, todoKeys, dashboards);
}
