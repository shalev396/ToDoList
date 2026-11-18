import type { DashboardCopy } from '@api-types/dashboards.ts';
import { workspaceKey } from '../../features/workspaces/switching.ts';

/** `GET …/dashboards` query: `topic` (a topic's id, `main` for the main dashboards) and `page`. */
export interface DashboardsFilter {
  topic?: string;
  page?: string;
}

/**
 * Shared React Query keys. Import from here so invalidations always match the query.
 *
 * Everything that belongs to one workspace goes under `workspaceKey(wid, …)`: switching
 * workspaces drops all of those at once (features/workspaces/switching.ts). Account-level data
 * (me, my workspaces, my invites) and stage facts stay.
 */
export const queryKeys = {
  me: ['me'] as const,
  runtime: ['runtime'] as const,
  workspaces: ['workspaces'] as const,
  myInvites: ['myInvites'] as const,
  members: (workspaceId: string) => workspaceKey(workspaceId, 'members'),
  /** How many private to-dos former members left: under members, refreshed with them. */
  formerMemberTodos: (workspaceId: string) => workspaceKey(workspaceId, 'members', 'former-todos'),
  invites: (workspaceId: string) => workspaceKey(workspaceId, 'invites'),
  joinLink: (workspaceId: string) => workspaceKey(workspaceId, 'join-link'),
  /** The workspace's topics (its pages), in sidebar order. */
  topics: (workspaceId: string) => workspaceKey(workspaceId, 'topics'),
  /** One list of dashboards; without a filter, every list (to invalidate them all). */
  dashboards: (workspaceId: string, filter?: DashboardsFilter) =>
    filter === undefined
      ? workspaceKey(workspaceId, 'dashboards')
      : workspaceKey(workspaceId, 'dashboards', filter),
  /** One copy of a dashboard: the draft (editors) or the published one (everyone). */
  dashboard: (workspaceId: string, dashboardId: string, as: DashboardCopy) =>
    workspaceKey(workspaceId, 'dashboard', dashboardId, as),
  /** Both copies of a dashboard. */
  dashboardCopies: (workspaceId: string, dashboardId: string) =>
    workspaceKey(workspaceId, 'dashboard', dashboardId),
  dashboardVersions: (workspaceId: string, dashboardId: string) =>
    workspaceKey(workspaceId, 'dashboardVersions', dashboardId),
  /** One block's result for the page variables it depends on (features/dashboards/variables). */
  block: (workspaceId: string, dashboardId: string, blockId: string, varsHash: string) =>
    workspaceKey(workspaceId, 'block', dashboardId, blockId, varsHash),
  /** Every block result of one dashboard. */
  dashboardBlocks: (workspaceId: string, dashboardId: string) =>
    workspaceKey(workspaceId, 'block', dashboardId),
  /** The workspace's custom attributes (H4). */
  attributes: (workspaceId: string) => workspaceKey(workspaceId, 'attributes'),
  catalog: (workspaceId: string) => workspaceKey(workspaceId, 'catalog'),
  templates: (workspaceId: string) => workspaceKey(workspaceId, 'templates'),
  viewTemplates: (workspaceId: string) => workspaceKey(workspaceId, 'viewTemplates'),
  personas: (workspaceId: string) => workspaceKey(workspaceId, 'personas'),
  facets: (workspaceId: string) => workspaceKey(workspaceId, 'facets'),
  /** The chips of "Also create in" (H5). */
  createTargets: (workspaceId: string) => workspaceKey(workspaceId, 'createTargets'),
  /** One funnel step's choices for one integration. */
  createOptions: (workspaceId: string, integrationId: string, query: unknown) =>
    workspaceKey(workspaceId, 'createOptions', integrationId, query),
  item: (workspaceId: string, itemId: string) => workspaceKey(workspaceId, 'item', itemId),
  syncRuns: (workspaceId: string) => workspaceKey(workspaceId, 'syncRuns'),
  integrations: (workspaceId: string) => workspaceKey(workspaceId, 'integrations'),
  /** Which of my integrations are on a block (shared): under integrations, refreshed with them. */
  integrationSharing: (workspaceId: string) => workspaceKey(workspaceId, 'integrations', 'sharing'),
  /** The workspace's primary calendar (where dated to-dos are pushed). */
  primaryCalendar: (workspaceId: string) => workspaceKey(workspaceId, 'primaryCalendar'),
  agentKeys: (workspaceId: string) => workspaceKey(workspaceId, 'agentKeys'),
  /** Everything of my own travel (places, rules, settings, days): one invalidation refreshes it. */
  travel: (workspaceId: string) => workspaceKey(workspaceId, 'travel'),
  travelPlaces: (workspaceId: string) => workspaceKey(workspaceId, 'travel', 'places'),
  travelRules: (workspaceId: string) => workspaceKey(workspaceId, 'travel', 'rules'),
  travelSettings: (workspaceId: string) => workspaceKey(workspaceId, 'travel', 'settings'),
  travelDays: (workspaceId: string, from: string, to: string) =>
    workspaceKey(workspaceId, 'travel', 'days', from, to),
  views: (workspaceId: string) => workspaceKey(workspaceId, 'views'),
  view: (workspaceId: string, viewId: string) => workspaceKey(workspaceId, 'view', viewId),
};
