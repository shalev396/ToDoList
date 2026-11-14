/**
 * Enums of the data model (docs/dashboard/DATA.md), shared by the server and the client
 * (`@api-types/domain`). Pure TypeScript: no imports, so the client can use it as is.
 *
 * Each enum is an `as const` array (for runtime checks and Mongoose `enum`) plus its union type.
 */

export const PROVIDERS = [
  'google_calendar',
  'jira',
  'clickup',
  'linear',
  'moodle',
  'slack',
  'github',
  'notion',
  'google_drive',
  'local',
] as const;
export type Provider = (typeof PROVIDERS)[number];

export const ITEM_KINDS = [
  'todo',
  'issue',
  'task',
  'event',
  'assignment',
  'deadline',
  'file',
  'message',
  'pr',
] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

export const ITEM_STATUSES = ['open', 'in_progress', 'done', 'cancelled'] as const;
export type ItemStatus = (typeof ITEM_STATUSES)[number];

export const CONTAINER_TYPES = ['project', 'course', 'list', 'calendar', 'folder', 'repo'] as const;
export type ContainerType = (typeof CONTAINER_TYPES)[number];

export const ROLES = ['viewer', 'editor', 'owner'] as const;
export type Role = (typeof ROLES)[number];

/** Compare roles by rank: a route that needs `editor` accepts `ROLE_RANK[role] >= ROLE_RANK.editor`. */
export const ROLE_RANK: Readonly<Record<Role, number>> = { viewer: 1, editor: 2, owner: 3 };

export const MEMBERSHIP_STATUSES = ['active', 'revoked'] as const;
export type MembershipStatus = (typeof MEMBERSHIP_STATUSES)[number];

export const INVITE_STATUSES = ['pending', 'accepted', 'revoked'] as const;
export type InviteStatus = (typeof INVITE_STATUSES)[number];

/** Internal integration status. The API, UI and MCP only ever see PUBLIC_INTEGRATION_STATUSES. */
export const INTEGRATION_STATUSES = ['active', 'expiring', 'expired', 'error', 'paused'] as const;
export type IntegrationStatus = (typeof INTEGRATION_STATUSES)[number];

export const PUBLIC_INTEGRATION_STATUSES = ['connected', 'expired', 'error'] as const;
export type PublicIntegrationStatus = (typeof PUBLIC_INTEGRATION_STATUSES)[number];

export const AUTH_METHODS = [
  /** Google Calendar through Google OAuth 2.0 (authorization code + PKCE, a refresh token). */
  'oauth',
  'service_account',
  'api_token_basic',
  'personal_token',
  'personal_api_key',
  'moodle_ws_token',
  'fine_grained_pat',
  'classic_pat',
  'internal_integration',
  'none',
] as const;
export type AuthMethod = (typeof AUTH_METHODS)[number];

export const INTEGRATION_MODES = ['read', 'read_write'] as const;
export type IntegrationMode = (typeof INTEGRATION_MODES)[number];

export const VISIBILITIES = ['workspace', 'private'] as const;
export type Visibility = (typeof VISIBILITIES)[number];

/** `calendar_push`: a confirmed Google Calendar push through the Calendar API (OAuth). */
export const SYNC_TRIGGERS = ['schedule', 'manual', 'webhook', 'calendar_push', 'seed'] as const;
export type SyncTrigger = (typeof SYNC_TRIGGERS)[number];

export const SYNC_RUN_STATUSES = ['queued', 'running', 'succeeded', 'partial', 'failed'] as const;
export type SyncRunStatus = (typeof SYNC_RUN_STATUSES)[number];

export const AGENT_SCOPES = [
  'read',
  'items:write',
  'sync',
  'gcal:write',
  /** H5: create a to-do in the user's own providers too (Jira, ClickUp…); never in a default key. */
  'providers:create',
  'integrations:read',
  'integrations:connect',
  'workspace:read',
  'workspace:share',
  'builder:write',
  'builder:publish',
] as const;
export type AgentScope = (typeof AGENT_SCOPES)[number];

export const CALENDAR_LINK_DIRECTIONS = ['to_google', 'from_google'] as const;
export type CalendarLinkDirection = (typeof CALENDAR_LINK_DIRECTIONS)[number];

export const DASHBOARD_PAGES = ['topic', 'group'] as const;
export type DashboardPage = (typeof DASHBOARD_PAGES)[number];
