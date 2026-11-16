/**
 * seedWorkspace: the demo data of one workspace, for the dev and qa stages (Workspace.create's
 * "Load demo data", POST /private/workspaces {loadDemoData: true}). The demo's specifics are in
 * demoData.ts (D17).
 *
 * It goes through the same classes a person's clicks do, acting as the workspace's owner, and
 * reaches the database only through them:
 * 1. one integration per demo account (Integration.connectAllWithKey, at once), on a stable
 *    account (Integration#pinAccount), marked `demo` (it never syncs, is never tested against its
 *    provider and is never written to: it stays read-only), with a FAKE credential
 *    (Integration.saveCredentials, at once: sealed like any other, never stored in plaintext);
 * 2. the demo area rules (`shalev396/*` → personal, `Braude*` → college);
 * 3. local to-dos (Todo.createAll, in one write): overdue, today, later this week and undated;
 * 4. the template dashboards (Dashboard.instantiateAll, at once), published; what exists is
 *    found by its outline (Dashboard.listOutlines);
 * 5. one fixture sync per integration (trigger `seed`), all together (Integration.syncTogether:
 *    each run replayed in memory, then every run's rows written at once): the items are the
 *    adapters' recorded fixtures, their relative dates resolved against `now` in the workspace's
 *    time zone, so they look exactly like a real sync's. Records without a URL are counted as the
 *    run's failures and never stored, as in any sync.
 *
 * Every query is a round trip to the database (from a local API to a stage's, a long one), so
 * each step writes its rows in one batch (a few dozen round trips in all, not hundreds), and
 * steps that don't depend on each other run at once: once the topics exist, 3 and the connects
 * of 1; after the connects, 4 (the pages bind the integrations by id and provider), 2, and the
 * accounts and credentials of 1; after 1 and 2, 5. A step that fails is waited out with the rest,
 * so nothing is still writing when the seed throws. What lists in creation order (the
 * integrations, the pages, so the template blocks' connectors; the to-dos) is written in demo
 * order, each a millisecond after the one before it, so the order holds within a batch.
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
import { settleAll } from '../utils/concurrency.js';

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

/** The owner's demo integration of `spec`, found by its account (or as the seed left it unpinned). */
function findIntegration(
  own: readonly Integration[],
  spec: DemoIntegration,
): Integration | undefined {
  const accountId = demoAccountId(spec);
  const existing = own.filter((integration) => integration.provider === spec.provider);
  return (
    existing.find((found) => found.accountId === accountId) ??
    existing.find((found) => isPlaceholderAccountId(found.accountId) && found.label === spec.label)
  );
}

/** The integration on its demo account (Integration#pinAccount, once). */
async function pinned({ spec, integration }: Connected): Promise<Connected> {
  const accountId = demoAccountId(spec);
  if (integration.accountId === accountId) return { spec, integration };
  const pinnedOne = await integration.pinAccount(accountId);
  if (pinnedOne === null) throw new Error(`seedWorkspace: could not set the ${spec.key} account`);
  return { spec, integration: pinnedOne };
}

/**
 * Every demo integration, in demoData.ts order. The missing ones connect at once
 * (Integration.connectAllWithKey) in demo order, so they list by creation in demo order (the
 * integration lists, the template blocks' connectors).
 */
async function connectIntegrations(caller: Caller): Promise<Connected[]> {
  // The owner's own: an integration belongs to the member who connected it (PERMISSIONS-V2).
  const own = await Integration.listOwn(caller);
  const found = DEMO_INTEGRATIONS.map((spec) => ({
    spec,
    integration: findIntegration(own, spec),
  }));
  const added = await Integration.connectAllWithKey(
    caller,
    found.flatMap(({ spec, integration }) =>
      integration === undefined ? [connectionOf(spec)] : [],
    ),
    { demo: true },
  );
  const remaining = [...added];
  return found.map(({ spec, integration }) => {
    const made = integration ?? remaining.shift();
    if (made === undefined) throw new Error(`seedWorkspace: ${spec.key} was not connected`);
    return { spec, integration: made };
  });
}

/**
 * The connected integrations on their demo accounts (Integration#pinAccount) and with their
 * credentials: the ones they lack saved at once (Integration.saveCredentials: FAKE ones, sealed
 * like any other).
 */
async function readyIntegrations(
  caller: Caller,
  connected: readonly Connected[],
): Promise<Connected[]> {
  const ready = await settleAll(connected.map(pinned));
  const withCredential = await Integration.withCredentials(
    caller.workspaceId,
    ready.map(({ integration }) => integration),
  );
  await Integration.saveCredentials(
    caller,
    ready
      .filter(({ integration }) => !withCredential.has(integration.id))
      .map(({ spec, integration }) => ({
        integration,
        body: fakeCredential(spec.authMethod, spec.key),
      })),
  );
  return ready;
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
 * The demo to-dos, created by the owner with an idempotency key each (its seed id), in one write
 * (Todo.createAll), in demo order. Returns the keys. One that exists, even deleted, is left as its
 * owner left it.
 */
async function ensureTodos(caller: Caller, now: Date, topics: TopicIds): Promise<string[]> {
  const keys = DEMO_TODOS.map((todo) => seedId(todo.name));
  const taken = await Todo.keysTaken(caller, keys);
  const missing = DEMO_TODOS.filter((todo) => !taken.has(seedId(todo.name)));
  await Todo.createAll(
    caller,
    missing.map((todo) => ({
      title: todo.title,
      topicId: topics[todo.topic],
      dueAt: dueAt(todo.due, now, caller.settings),
      ...(todo.priority === undefined ? {} : { priority: todo.priority }),
      ...(todo.note === undefined ? {} : { note: todo.note }),
      idempotencyKey: seedId(todo.name),
    })),
  );
  return keys;
}

/**
 * A new workspace without sample data starts minimal (D1): the Personal topic and one empty
 * Personal page. The demo wants all three default topics: the missing ones are added. Answers the
 * default topics' ids.
 */
async function defaultTopics(caller: Caller, language: TemplateLanguage): Promise<TopicIds> {
  const all = await Topic.ensureDefaults(caller.workspaceId, DEFAULT_TOPIC_SLUGS, language);
  const idOf = (slug: DefaultTopicSlug): string => {
    const topic = all.find((entry) => entry.slug === slug);
    if (topic === undefined) throw new Error(`seedWorkspace: no ${slug} topic`);
    return topic.id;
  };
  return { work: idOf('work'), college: idOf('college'), personal: idOf('personal') };
}

/**
 * The minimal workspace's empty Personal page, if nobody has put anything on it, is deleted: the
 * demo's template page replaces it.
 */
async function deleteEmptyPage(caller: Caller, topics: TopicIds): Promise<void> {
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
}

/**
 * The demo dashboards from their templates (published: the owner creates them), the missing ones
 * at once (Dashboard.instantiateAll) in demo order, as the pages list by creation.
 */
async function ensureDashboards(
  caller: Caller,
  language: TemplateLanguage,
  topics: TopicIds,
): Promise<number> {
  const existing = await Dashboard.listOutlines(caller);
  const templates = new Map(listTemplates().map((template) => [template.key, template]));
  const missing = DEMO_DASHBOARDS.flatMap((demo) => {
    const template = templates.get(demo.templateKey);
    if (template === undefined) throw new Error(`seedWorkspace: no template ${demo.templateKey}`);
    const topicId = demo.topic === undefined ? null : topics[demo.topic];
    const found = existing.some(
      (dashboard) =>
        dashboard.templateKey === template.key &&
        dashboard.scope.topicId === topicId &&
        dashboard.scope.page === template.scope.page,
    );
    if (found) return [];
    return [
      { templateKey: template.key, language, ...(topicId === null ? {} : { scope: { topicId } }) },
    ];
  });
  await Dashboard.instantiateAll(caller, missing);
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

/**
 * One fixture sync per integration, all at once: their runs are written together
 * (Integration.syncTogether), in a handful of round trips instead of dozens per integration.
 */
async function syncAll(
  workspaceId: string,
  connected: readonly Connected[],
  now: Date,
  timeZone: string,
): Promise<SyncRunSummary[]> {
  const requests = await Promise.all(
    connected.map(async ({ spec, integration }) => {
      const transport = await fixtureReplay(integration.provider, spec.fixtureSet, now, timeZone);
      return {
        integrationId: integration.id,
        options: {
          trigger: 'seed' as const,
          mode: 'fixtures' as const,
          fixtureSet: spec.fixtureSet,
          now,
          // Fixture replays never wait on a provider's request throttle (Moodle: 1 s per request).
          clock: noWaitClock,
          ...(transport === null ? {} : { transport }),
        },
      };
    }),
  );
  return Integration.syncTogether(workspaceId, requests);
}

async function summarize(
  caller: Caller,
  connected: readonly Connected[],
  runs: readonly SyncRunSummary[],
  todoKeys: readonly string[],
  dashboards: number,
): Promise<SeedSummary> {
  const { workspaceId } = caller;
  const ids = connected.map(({ integration }) => integration.id);
  // Counted at once, in one read each.
  const [items, containers, localTodos] = await Promise.all([
    Item.countLiveOfEach(workspaceId, ids),
    Container.countLiveOfEach(workspaceId, ids),
    Todo.countLiveWithKeys(caller, todoKeys),
  ]);
  const integrations = connected.map(({ spec, integration }, index): SeededIntegration => {
    const run = runs[index];
    if (run === undefined) throw new Error('seedWorkspace: a sync result is missing');
    return {
      key: spec.key,
      provider: integration.provider,
      label: integration.label,
      integrationId: integration.id,
      topicId: integration.topicId,
      status: run.status,
      error: run.error?.code ?? null,
      items: items.get(integration.id) ?? 0,
      containers: containers.get(integration.id) ?? 0,
      failed: run.counts.failed,
    };
  });
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
  const caller = await Caller.enter(workspaceId, Actor.user(ownerId));
  if (caller?.role.name !== 'owner') {
    throw new Error('seedWorkspace: the workspace has no owner');
  }

  const language = options.language ?? 'en';
  const topics = await defaultTopics(caller, language);
  // The empty page, the to-dos and the connects need only the topics.
  const emptyPageGone = deleteEmptyPage(caller, topics);
  const todosDone = ensureTodos(caller, now, topics);
  const connectedDone = connectIntegrations(caller);
  // The dashboards bind the owner's integrations by id and provider: they follow the connects.
  const dashboardsDone = connectedDone.then(async (connected) => {
    const count = await ensureDashboards(caller, language, topics);
    await ensureConnectorBlocks(caller, connected, language);
    return count;
  });
  // The rules wait for the connects too: connecting GitHub appends its own topic rule to the same
  // list ensureTopicRules rewrites. Beside them, each integration gets its account and credential.
  const rulesDone = connectedDone.then(() => ensureTopicRules(caller, topics));
  const readyDone = connectedDone.then((connected) => readyIntegrations(caller, connected));
  // The syncs file by the rules, on the integrations' accounts; the dashboards never read what
  // they write.
  const runsDone = settleAll([readyDone, rulesDone] as const).then(([ready]) =>
    syncAll(workspaceId, ready, now, caller.settings.timezone),
  );
  // A step that fails is waited out with the rest, so nothing is still writing when this throws.
  const [, todoKeys, , dashboards, , connected, runs] = await settleAll([
    emptyPageGone,
    todosDone,
    connectedDone,
    dashboardsDone,
    rulesDone,
    readyDone,
    runsDone,
  ] as const);
  return summarize(caller, connected, runs, todoKeys, dashboards);
}
