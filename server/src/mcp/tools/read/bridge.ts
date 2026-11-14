/**
 * The read tools find items with the Logic Bridge, the service behind POST /query: the same
 * compiler the dashboards use, so "today", "this week" and the calendar's start-or-due date mean
 * what they mean on a dashboard (workspace time zone, week start, access filter). They answer
 * with the items service's summaries of what it found, in the bridge's order.
 */
import { getItemSummaries } from '../../../services/items.js';
import { runWorkspaceQuery } from '../../../services/workspaceQuery.js';
import type { Query, Rule } from '../../../types/builder.js';
import type { ItemKind, Provider } from '../../../types/domain.js';
import type { ToolContext } from '../../tool.js';
import { toItemSummaryView, type ItemSummaryView } from '../itemViews.js';

/** Statuses that still need doing: what deadlines and "overdue" are about. */
export const OPEN_STATUSES = ['open', 'in_progress'];

/** The beginning of time, for "everything due before…" ranges. */
export const EPOCH = new Date(0);

export interface ListFilters {
  /** Topic ids (resolved from the agent's slugs with topicIds). */
  topic?: string[] | undefined;
  provider?: Provider[] | undefined;
  kind?: ItemKind[] | undefined;
}

/** The agent's list filters as query rules; nothing is filtered that the agent did not ask for. */
export function filterRules(filters: ListFilters): Rule[] {
  return [
    ...(filters.topic === undefined
      ? []
      : [{ field: 'topic', operator: 'in' as const, value: filters.topic }]),
    ...(filters.provider === undefined
      ? []
      : [{ field: 'source.provider', operator: 'in' as const, value: filters.provider }]),
    ...(filters.kind === undefined
      ? []
      : [{ field: 'kind', operator: 'in' as const, value: filters.kind }]),
  ];
}

/** `{combinator: and}` of the rules, or nothing when there are none. */
export function where(rules: Rule[]): Pick<Query, 'where'> {
  return rules.length === 0 ? {} : { where: { combinator: 'and', rules } };
}

export function range(from: Date, to: Date): { from: string; to: string } {
  return { from: from.toISOString(), to: to.toISOString() };
}

/** Runs a draft query and returns the matching items' summaries, in the query's order. */
export async function findItems(
  ctx: ToolContext,
  draft: Query,
  now: Date = ctx.now(),
): Promise<{ items: ItemSummaryView[]; total: number }> {
  const result = await runWorkspaceQuery(ctx.workspace, ctx.principal.userId, { draft }, now);
  const ids = (result.rows ?? []).map((row) => row.id);
  const summaries = await getItemSummaries(ctx.workspace, ctx.principal.userId, ids);
  return { items: summaries.map(toItemSummaryView), total: result.total };
}
