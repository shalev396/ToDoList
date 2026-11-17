/**
 * Which dashboard a route shows, and which template starts one when there is none.
 *
 * - `/dashboard`: the oldest dashboard without a topic (`?topic=main`) that is a topic page.
 * - `/t/:topic`: the oldest topic page of that topic (by its id).
 * - `/t/:topic/:group`: the group page made for that group, else the topic's generic one
 *   (`containerId: null`), which shows whichever group the route names.
 */
import type { DashboardSummary } from '@api-types/dashboards.ts';
import type { DashboardRoute } from './variables/routeBindings.ts';

/** `GET …/dashboards` query (server/src/routes/private/dashboards.ts ListDashboardsQuery). */
export interface DashboardListFilter {
  /** A topic's id, or `main`. */
  topic: string;
  page?: 'topic' | 'group';
}

export type TemplateName =
  | 'dashboard'
  | 'work'
  | 'college'
  | 'personal'
  | 'college-course'
  | 'project';

/** `POST …/dashboards` body without the language. Topic and group pages name their topic. */
export interface TemplateChoice {
  fromTemplate: TemplateName;
  scope?: { topicId: string };
}

export function dashboardListFilter(route: DashboardRoute): DashboardListFilter {
  switch (route.kind) {
    case 'main':
      return { topic: 'main' };
    case 'topic':
      return { topic: route.topic.id, page: 'topic' };
    case 'group':
      return { topic: route.topic.id, page: 'group' };
  }
}

/** The dashboard to show from a list (oldest first, as the API answers), or null. */
export function pickDashboard(
  list: readonly DashboardSummary[],
  route: DashboardRoute,
): DashboardSummary | null {
  switch (route.kind) {
    case 'main':
      return list.find(({ scope }) => scope.topicId === null && scope.page === 'topic') ?? null;
    case 'topic':
      return (
        list.find(({ scope }) => scope.topicId === route.topic.id && scope.page === 'topic') ?? null
      );
    case 'group': {
      const groups = list.filter(
        ({ scope }) => scope.topicId === route.topic.id && scope.page === 'group',
      );
      return (
        groups.find(({ scope }) => scope.containerId === route.group) ??
        groups.find(({ scope }) => scope.containerId === null) ??
        null
      );
    }
  }
}

/** A default topic's own layout; any other topic starts from the Work one (projects, sources). */
function topicTemplate(slug: string): TemplateName {
  return slug === 'college' || slug === 'personal' ? slug : 'work';
}

export function templateFor(route: DashboardRoute): TemplateChoice {
  switch (route.kind) {
    case 'main':
      return { fromTemplate: 'dashboard' };
    case 'topic':
      return { fromTemplate: topicTemplate(route.topic.slug), scope: { topicId: route.topic.id } };
    case 'group':
      return {
        fromTemplate: route.topic.slug === 'college' ? 'college-course' : 'project',
        scope: { topicId: route.topic.id },
      };
  }
}
