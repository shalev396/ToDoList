import { z } from 'zod';

import { runWorkspaceQuery } from '../../../services/workspaceQuery.js';
import { QueryRequestSchema } from '../../../types/builder.js';
import { defineTool } from '../../tool.js';
import { TopicList, withinTopics } from '../itemViews.js';

type Row = Record<string, unknown>;

/** Dates as ISO strings (structured content is JSON), and openIn on every item row. */
function toRow(row: object): Row {
  const json = JSON.parse(JSON.stringify(row)) as Row;
  const source = json['source'];
  if (typeof source !== 'object' || source === null || !('kind' in json)) return json;
  const { provider, url } = source as { provider?: unknown; url?: unknown };
  return { ...json, openIn: { provider, url } };
}

export const queryItems = defineTool({
  name: 'query_items',
  title: 'Query items',
  description:
    'Runs a query through the Logic Bridge, as a dashboard block does: a saved view (savedQueryId), a dashboard block (dashboardId and blockId), or a draft query (the schema is in todolist://schema/query). vars set the $page.* cross-block filters. A draft reads as a task view (no time blocks, areas or travel legs) unless a rule asks for them by name (kind = block, or kind in a list holding block or travel) or blockType is a time view (calendar, clock, timeline, agenda, workload, timesheet; a timesheet’s range narrows only its timed rows, never its to-dos). Answers rows (each item row with source and openIn) or groups, the total, the variables used and any warnings.',
  toolset: 'read',
  inputSchema: QueryRequestSchema.safeExtend({
    topic: TopicList.describe(
      'Only items (and containers) in these topics (slugs as workspace_get lists them), whatever the query',
    ),
  }),
  outputSchema: z.object({
    rows: z.array(z.record(z.string(), z.unknown())).optional(),
    groups: z.array(z.record(z.string(), z.unknown())).optional(),
    total: z.number().int(),
    appliedVars: z.record(z.string(), z.unknown()),
    warnings: z.array(z.string()),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['read'],
  minRole: 'viewer',
  async handler(ctx, input) {
    const { topic, ...body } = input;
    const result = await runWorkspaceQuery(
      await withinTopics(ctx.workspace, topic),
      ctx.principal.userId,
      body,
      ctx.now(),
    );
    return {
      output: {
        ...(result.rows === undefined ? {} : { rows: result.rows.map(toRow) }),
        ...(result.groups === undefined
          ? {}
          : { groups: result.groups.map((group) => JSON.parse(JSON.stringify(group)) as Row) }),
        total: result.total,
        appliedVars: JSON.parse(JSON.stringify(result.appliedVars)) as Row,
        warnings: [...result.warnings],
      },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
