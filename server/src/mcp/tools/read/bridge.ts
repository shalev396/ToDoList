/**
 * The read tools find items with the Logic Bridge, the service behind POST /query: the same
 * compiler the dashboards use, so "today", "this week" and the calendar's start-or-due date mean
 * what they mean on a dashboard (workspace time zone, week start, access filter). They answer
 * with the items service's summaries of what it found, in the bridge's order.
 *
 * A draft without a block type is task-shaped (it leaves time blocks, areas and travel out unless
 * a rule names a kind); the time tools pass a time-shaped block type and expand what they find
 * into occurrences, with the expansion the dashboards share (types/recurrence).
 */
import { runWorkspaceQuery } from '../../../services/workspaceQuery.js';
import type { BlockType, ItemQueryRow, Query, Rule } from '../../../types/builder.js';
import type { ItemKind, Provider } from '../../../types/domain.js';
import { expandOccurrences, type Range } from '../../../types/recurrence/occurrences.js';
import type { ToolContext } from '../../tool.js';
import {
  itemReads,
  toItemSummaryView,
  toOccurrenceView,
  type ItemSummaryView,
} from '../itemViews.js';

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

/** What a draft found: the summaries, the rows they came from (for the expansion), the total. */
export interface Found {
  items: ItemSummaryView[];
  rows: ItemQueryRow[];
  total: number;
}

/**
 * Runs a draft query and returns the matching items' summaries, in the query's order. With a
 * `blockType`, the draft is read as that block reads it (a time-shaped type holds reserved time).
 */
export async function findItems(
  ctx: ToolContext,
  draft: Query,
  now: Date = ctx.now(),
  options: { blockType?: BlockType } = {},
): Promise<Found> {
  const result = await runWorkspaceQuery(
    ctx.workspace,
    ctx.principal.userId,
    { draft, ...(options.blockType === undefined ? {} : { blockType: options.blockType }) },
    now,
  );
  const rows = (result.rows ?? []).filter((row): row is ItemQueryRow => 'kind' in row);
  const summaries = await (await itemReads(ctx)).summaries(rows.map((row) => row.id));
  return { items: summaries.map(toItemSummaryView), rows, total: result.total };
}

/**
 * One entry per occurrence in `bounds` of what a time-shaped draft found, in time order: a series
 * (a Google master or a time block that repeats) gives one per occurrence, moved and skipped ones
 * applied; a cancelled or disabled one is listed with `inactive` (busy false), as on the calendar.
 */
export function occurrencesOf(found: Found, bounds: Range, timeZone: string): ItemSummaryView[] {
  const byId = new Map(found.items.map((item) => [item.id, item]));
  return expandOccurrences(found.rows, bounds, timeZone).flatMap((occurrence) => {
    const summary = byId.get(occurrence.row.id);
    return summary === undefined ? [] : [toOccurrenceView(summary, occurrence)];
  });
}
