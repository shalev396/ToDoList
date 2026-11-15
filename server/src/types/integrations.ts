/**
 * Integrations and sync over the API (BACKEND.md §4, DATA.md §3.4–3.5, §3.9): the shapes the
 * server and the client share (`@api-types/integrations`). Types and constant lists only.
 *
 * A secret travels one way: in the body of `PUT …/integrations/:iid/credential`. No response ever
 * carries one, in any form. An integration is shown as `IntegrationStatusView`
 * (models/definitions/Integration.ts) and nothing else.
 */
import type { Query } from './builder.js';
import type { AuthMethod, SyncRunStatus, SyncTrigger } from './domain.js';

/** Providers an owner can connect through the API. Slack, Notion and local are not among them. */
export const CONNECTABLE_PROVIDERS = [
  'jira',
  'clickup',
  'linear',
  'moodle',
  'google_calendar',
  'github',
] as const;
export type ConnectableProvider = (typeof CONNECTABLE_PROVIDERS)[number];

/**
 * Providers shown on the Integrations page that cannot be connected yet: a connect through REST or
 * MCP answers `provider_coming_soon` (the adapter and fixtures stay; the demo seed may use it).
 */
export const COMING_SOON_PROVIDERS = ['moodle'] as const satisfies readonly ConnectableProvider[];

/**
 * The fields of an item (the Item model's own) that a mirrored item may write back to its provider
 * when its integration is read & write (plan Addendum A1). Each provider's definition names the
 * ones its API really has (`writableFields`); every other field of the item stays in TodoList.
 * `dueAt` carries `allDay` with it, and so does an event's time (`startAt`, `endAt`).
 */
export const WRITABLE_FIELDS = [
  'title',
  'status',
  'dueAt',
  'startAt',
  'endAt',
  'priority',
] as const;
export type WritableField = (typeof WRITABLE_FIELDS)[number];

// ─── Non-secret config, per provider ────────────────────────────────────────

export interface JiraConfig {
  /** `https://<site>.atlassian.net`. Its host is the integration's account (token connections). */
  baseUrl?: string;
  /** An OAuth connection (one grant): the sites it reads, chosen from the grant's own list. */
  sites?: { cloudId: string; url: string; name: string }[];
  jql?: string;
}

/** Linear takes no settings. */
export type EmptyConfig = Record<string, never>;

export interface ClickUpConfig {
  /** An OAuth connection: the workspaces it reads (all when absent). */
  teamIds?: string[];
}

export interface MoodleConfig {
  /** e.g. `https://moodle.example.ac.il`. Its host is the integration's account. */
  siteUrl: string;
}

export interface GoogleCalendarConfig {
  calendars: { id: string; mode: 'two_way' | 'read' }[];
  targetCalendarId?: string;
  /** Which items are pushed to the calendar: a builder query (BUILDER.md). */
  pushFilter?: Query;
  horizonDays?: number;
  maxOpsPerRun?: number;
}

export interface GitHubConfig {
  /** A user or organization login. It is the integration's account. */
  owner: string;
  ownerType: 'user' | 'org';
  repos?: { include?: string[]; forks?: boolean; archived?: boolean };
  issues?: {
    involvement?: ('assigned' | 'created')[];
    closedWithinDays?: number;
  };
  /**
   * Projects (v2) boards. `enabled` follows the connection test (false when the token can't read
   * boards); `include` takes board numbers or title globs.
   */
  boards?: { enabled?: boolean; include?: (number | string)[]; dueField?: string };
}

export interface IntegrationConfigs {
  jira: JiraConfig;
  clickup: ClickUpConfig;
  linear: EmptyConfig;
  moodle: MoodleConfig;
  google_calendar: GoogleCalendarConfig;
  github: GitHubConfig;
}

// ─── The credential (write-only), per auth method ───────────────────────────

/** Jira (`api_token_basic`). */
export interface JiraCredential {
  email: string;
  token: string;
}

/** ClickUp (`personal_token`) and Moodle (`moodle_ws_token`). */
export interface TokenCredential {
  token: string;
}

/** Linear (`personal_api_key`). */
export interface LinearCredential {
  apiKey: string;
}

/** Google Calendar read through a service account (`service_account`): the demo's fixtures only. */
export interface ServiceAccountCredential {
  clientEmail: string;
  privateKey: string;
}

/** GitHub (`fine_grained_pat`): `projectsToken` is a classic PAT for a personal account's boards. */
export interface GitHubCredential {
  token: string;
  projectsToken?: string;
}

export type IntegrationCredential =
  | JiraCredential
  | TokenCredential
  | LinearCredential
  | ServiceAccountCredential
  | GitHubCredential;

// ─── Test connection ────────────────────────────────────────────────────────

/** Why a connection test failed: a fixed code, never provider text. */
export const INTEGRATION_TEST_CODES = [
  // The provider's answer (sync/errors.ts).
  'auth_failed',
  'not_found',
  'gone',
  'rate_limited',
  'client_error',
  'server_error',
  'bad_response',
  'network',
  // Before or around the call.
  'no_adapter',
  'not_supported',
  'fixtures_missing',
  'credential_missing',
  'credential_unavailable',
  'already_connected',
  'internal',
] as const;
export type IntegrationTestCode = (typeof INTEGRATION_TEST_CODES)[number];

export type IntegrationTestResult =
  | { ok: true; accountLabel: string; capabilities?: Record<string, boolean> }
  | { ok: false; code: IntegrationTestCode };

// ─── Sync runs ──────────────────────────────────────────────────────────────

/** One sync run, sanitized: counts and a fixed `{code, message}`, never provider data. */
export interface SyncRunView {
  id: string;
  integrationId: string;
  trigger: SyncTrigger;
  status: SyncRunStatus;
  startedAt: Date;
  finishedAt: Date | null;
  /** e.g. `{fetched, inserted, updated, unchanged, deleted, failed}`. */
  counts: Record<string, number>;
  error: { code: string; message: string } | null;
}

// ─── OAuth sign-in (GitHub, Jira, ClickUp, Linear) ──────────────────────────

/** The providers that connect with OAuth besides Google Calendar. */
export const OAUTH_SIGN_IN_PROVIDERS = ['github', 'jira', 'clickup', 'linear'] as const;
export type OAuthSignInProvider = (typeof OAUTH_SIGN_IN_PROVIDERS)[number];

/**
 * What the Integrations page shows about one provider's sign-in. Only whether it works on this
 * stage: how the operator sets an OAuth app up is INTEGRATIONS-SETUP.md's, never the product's.
 */
export interface OAuthProviderInfo {
  /** Google Calendar signs in with its own routes; the others share the provider routes. */
  provider: OAuthSignInProvider | 'google_calendar';
  /** This stage has the OAuth app's id and secret. */
  configured: boolean;
  /** GitHub: where the user installs the app on the repositories and organizations to read. */
  installUrl: string | null;
}

/**
 * What a provider can do and how it connects, from its class (Integration.capabilitiesOf): the
 * Integrations page reads this instead of keeping its own lists.
 */
export interface ProviderCapabilities {
  provider: ConnectableProvider;
  /** How users connect it: `oauth` (sign-in) first, then the key methods (never the demo's). */
  authMethods: AuthMethod[];
  /**
   * What its OAuth grant lets its owner pick after connecting: Jira sites, ClickUp workspaces,
   * Google calendars; null: nothing.
   */
  picker: 'sites' | 'workspaces' | 'calendars' | null;
  /** TodoList hands the OAuth grant back to the provider when it is disconnected. */
  revokesOnDisconnect: boolean;
  /** Where a user revokes the app themselves when TodoList doesn't (null: nowhere to point). */
  revokePage: string | null;
  /** An item can be created there from a to-do ("Also create in"). */
  canCreate: boolean;
  /** Listed, but not open to connect yet. */
  comingSoon: boolean;
}

export interface OAuthProvidersResponse {
  stage: 'dev' | 'qa' | 'prod';
  providers: OAuthProviderInfo[];
  /** Every connectable provider's capabilities, in the order of CONNECTABLE_PROVIDERS. */
  capabilities: ProviderCapabilities[];
}

/** A Jira site (cloud id) or ClickUp workspace a grant can read. */
export interface OAuthResource {
  id: string;
  name: string;
  url?: string;
}
