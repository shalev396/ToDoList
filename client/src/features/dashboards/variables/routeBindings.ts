/**
 * Page variables fixed by the route (FRONTEND.md §1):
 * - `/t/:topic/:group` sets `$page.<scope.groupVar>` to the group (a course or project id). Group
 *   dashboards declare which variable that is (`course`, `project`); it is never inferred.
 * - `/t/:topic` (and its group pages) sets `$page.topic` to the topic's id when the dashboard
 *   declares a `topic` variable (topic templates filter `topic = $page.topic`).
 * The main dashboard binds nothing.
 */
import type { DashboardScope, DashboardVars, VarValue } from '@api-types/builder.ts';
import { VAR_NAME_PATTERN } from './names.ts';
import type { PageVars } from './urlVars.ts';

/** The topic a route opens (`/t/<slug>`): the workspace's topic with that slug. */
export interface RouteTopic {
  id: string;
  slug: string;
  name: string;
}

export type DashboardRoute =
  | { kind: 'main' }
  | { kind: 'topic'; topic: RouteTopic }
  | { kind: 'group'; topic: RouteTopic; group: string };

const TOPIC_VAR = 'topic';

/**
 * The variable a group dashboard binds its route's group to. `scope.groupVar` may be missing
 * (dashboards from before it existed); then nothing is bound.
 */
export function groupVarOf(scope: DashboardScope): string | null {
  const declared: unknown = 'groupVar' in scope ? scope.groupVar : undefined;
  return typeof declared === 'string' && VAR_NAME_PATTERN.test(declared) ? declared : null;
}

export function routeBindings(
  dashboard: { scope: DashboardScope; vars: DashboardVars },
  route: DashboardRoute,
): PageVars {
  const bound = Object.create(null) as Record<string, VarValue>;
  if (route.kind === 'main') {
    return bound;
  }
  if (Object.hasOwn(dashboard.vars, TOPIC_VAR)) {
    bound[TOPIC_VAR] = route.topic.id;
  }
  if (route.kind === 'group') {
    const groupVar = groupVarOf(dashboard.scope);
    if (groupVar !== null) {
      bound[groupVar] = route.group;
    }
  }
  return bound;
}
