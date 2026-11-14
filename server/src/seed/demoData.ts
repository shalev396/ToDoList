/**
 * What the demo workspace holds (DECISIONS D17: the demo's specifics live only in the seed). The
 * integrations' config must name exactly what the adapters' fixtures were recorded against
 * (task-T3.3 reports): fixtures mode matches requests by origin and path, so any other Jira base
 * URL, Moodle site, calendar or GitHub owner ends the sync as `fixtures_missing`.
 *
 * Data only, with no environment read.
 */
import type { DefaultTopicSlug } from '../types/topics.js';
import type { ConnectableProvider } from '../types/integrations.js';
import type { SeedAuthMethod } from './fakeCredentials.js';

export interface DemoIntegration {
  /**
   * The seed's name for it: its FAKE credential is built from it, and so is its account id when
   * the provider names the account only in a connection test (ClickUp, Linear, Google).
   */
  key: string;
  provider: ConnectableProvider;
  label: string;
  authMethod: SeedAuthMethod;
  /** As `POST …/integrations` takes it; the provider's default topic applies. */
  config: Record<string, unknown>;
  /** The adapter's fixture set its data replays. */
  fixtureSet: string;
}

export const DEMO_INTEGRATIONS: readonly DemoIntegration[] = [
  {
    key: 'jira',
    provider: 'jira',
    label: 'AutoDS Jira',
    authMethod: 'api_token_basic',
    config: { baseUrl: 'https://example.invalid/jira' },
    fixtureSet: 'v1',
  },
  {
    key: 'clickup',
    provider: 'clickup',
    label: 'Roonga and Parkbooker',
    authMethod: 'personal_token',
    config: {},
    fixtureSet: 'v1',
  },
  {
    key: 'linear',
    provider: 'linear',
    label: 'Personal Linear',
    authMethod: 'personal_api_key',
    config: {},
    fixtureSet: 'v1',
  },
  {
    // Moodle is "coming soon" for users (createIntegration refuses it); the demo keeps its sample
    // items, which the seed creates directly (DECISIONS: Moodle is coming soon).
    key: 'moodle',
    provider: 'moodle',
    label: 'Braude Moodle',
    authMethod: 'moodle_ws_token',
    config: { siteUrl: 'https://example.invalid/moodle' },
    fixtureSet: 'v1',
  },
  {
    // Read through a service account, as the adapter and its fixtures do (no two-way bridge).
    key: 'google-calendar',
    provider: 'google_calendar',
    label: 'Google Calendar',
    authMethod: 'service_account',
    config: {
      calendars: [
        { id: 'personal@example.invalid', mode: 'read' },
        { id: 'college@example.invalid', mode: 'read' },
      ],
    },
    fixtureSet: 'v1',
  },
  {
    // Connecting a user's GitHub adds the `shalev396/*` → personal rule.
    key: 'github-user',
    provider: 'github',
    label: 'shalev396',
    authMethod: 'fine_grained_pat',
    config: { owner: 'shalev396', ownerType: 'user' },
    fixtureSet: 'v1',
  },
  {
    key: 'github-org',
    provider: 'github',
    label: 'acme-labs',
    authMethod: 'fine_grained_pat',
    config: { owner: 'acme-labs', ownerType: 'org' },
    fixtureSet: 'orgs',
  },
];

/** A topic rule of the demo, its topic named by its default slug (the seed resolves the id). */
export interface DemoTopicRule {
  match: string;
  topic: DefaultTopicSlug;
}

/** The demo's topic rules: the user's own repos, and the college classes calendar. */
export const DEMO_TOPIC_RULES: readonly DemoTopicRule[] = [
  { match: 'shalev396/*', topic: 'personal' },
  { match: 'Braude*', topic: 'college' },
];

/** When a demo to-do is due: days from today (end of that day), later this week, or never. */
export type DemoDue = { days: number } | 'later_this_week' | null;

export interface DemoTodo {
  /** The seed's name for it: its idempotency key is seedId(name). */
  name: string;
  title: string;
  topic: DefaultTopicSlug;
  due: DemoDue;
  /** 0 (lowest) to 4 (most urgent). */
  priority?: number;
  note?: string;
}

export const DEMO_TODOS: readonly DemoTodo[] = [
  {
    name: 'todo/autods-weekly-update',
    title: 'Send the AutoDS weekly update',
    topic: 'work',
    due: { days: 0 },
    priority: 3,
  },
  {
    name: 'todo/passport',
    title: 'Renew the passport',
    topic: 'personal',
    due: { days: -2 },
    priority: 2,
    note: 'Book an appointment first; bring the old passport and a photo.',
  },
  {
    name: 'todo/clrs-chapter-4',
    title: 'Read CLRS chapter 4 before the Algorithms lecture',
    topic: 'college',
    due: 'later_this_week',
  },
  {
    name: 'todo/elytra-release-notes',
    title: 'Draft the Elytra release notes',
    topic: 'personal',
    due: 'later_this_week',
    priority: 1,
  },
  { name: 'todo/weekend-hike', title: 'Plan the weekend hike', topic: 'personal', due: null },
];

export interface DemoDashboard {
  templateKey: string;
  /** The default topic whose page it is; none: the main dashboard. */
  topic?: DefaultTopicSlug;
}

/** In the order a person would add them: the main dashboard first. */
export const DEMO_DASHBOARDS: readonly DemoDashboard[] = [
  { templateKey: 'dashboard@1' },
  { templateKey: 'work@1', topic: 'work' },
  { templateKey: 'college@1', topic: 'college' },
  { templateKey: 'personal@1', topic: 'personal' },
  { templateKey: 'college-course@1', topic: 'college' },
  { templateKey: 'project@1', topic: 'work' },
  { templateKey: 'project@1', topic: 'personal' },
];

/**
 * Dashboards that read naturally from chosen connectors (a block's `connectors`): Work's "Tasks"
 * list is the ClickUp and Jira accounts, ordered by status.
 */
export interface DemoConnectorBlock {
  templateKey: string;
  /** The demo integrations (DEMO_INTEGRATIONS keys) the block reads. */
  connectors: readonly string[];
  titles: { en: string; he: string };
}

export const DEMO_CONNECTOR_BLOCKS: readonly DemoConnectorBlock[] = [
  {
    templateKey: 'work@1',
    connectors: ['clickup', 'jira'],
    titles: { en: 'Tasks', he: 'משימות' },
  },
];

/**
 * The fixture set a demo integration replays (the acme-labs org keeps its own recordings): the
 * demo integration of that provider (and owner, when it names one), or undefined for an
 * integration the seed did not make.
 */
export function demoFixtureSet(
  provider: string,
  config: Readonly<Record<string, unknown>>,
): string | undefined {
  return DEMO_INTEGRATIONS.find(
    (spec) =>
      spec.provider === provider &&
      (spec.config['owner'] === undefined || spec.config['owner'] === config['owner']),
  )?.fixtureSet;
}
