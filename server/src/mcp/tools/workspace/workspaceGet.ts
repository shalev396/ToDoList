import { z } from 'zod';

import { Topic, Workspace } from '../../../classes/workspace/index.js';
import { toolCaller } from '../../auth/principal.js';
import { AGENT_SCOPES, ROLES } from '../../../types/domain.js';
import { defineTool } from '../../tool.js';

const Output = z.object({
  topics: z
    .array(z.object({ id: z.string(), slug: z.string(), name: z.string() }))
    .describe('The pages of the workspace, in sidebar order'),
  workspace: z.object({
    id: z.string(),
    name: z.string(),
    slug: z.string(),
    settings: z.object({
      timezone: z.string().describe('IANA time zone'),
      weekStart: z.enum(['sun', 'mon']),
      topicRules: z
        .array(z.object({ match: z.string(), topicId: z.string() }))
        .describe('Container match globs → a topic; the first match wins'),
      allowAgentPublish: z.boolean().describe('Agents with builder:publish may publish dashboards'),
    }),
  }),
  member: z.object({
    userId: z.string(),
    role: z.enum(ROLES),
  }),
  agent: z.object({
    id: z.string().describe('This agent key’s id, as audit_log_query reports it'),
    scopes: z.array(z.enum(AGENT_SCOPES)).describe('What this key may do here'),
  }),
});

export const workspaceGet = defineTool({
  name: 'workspace_get',
  title: 'Get workspace',
  description:
    'The workspace (workspace) this agent key belongs to: its name, slug and settings (time zone, week start, topic rules), its topics (pages: id, slug, name, in sidebar order; read and build tools name them by slug), the role of the member the key acts for, and the scopes this key may use here.',
  toolset: 'workspace',
  inputSchema: z.strictObject({}),
  outputSchema: Output,
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['workspace:read'],
  minRole: 'viewer',
  async handler(ctx) {
    const caller = toolCaller(ctx);
    const workspace = await Workspace.load(caller);
    const role = caller.role.name;
    const { settings } = workspace;
    const topics = await Topic.list(ctx.workspace.id);
    return {
      output: {
        topics: topics.map(({ id, slug, name }) => ({ id, slug, name })),
        workspace: {
          id: workspace.id,
          name: workspace.name,
          slug: workspace.slug,
          settings: {
            timezone: settings.timezone,
            weekStart: settings.weekStart,
            topicRules: settings.topicRules.toJSON(),
            allowAgentPublish: settings.allowAgentPublish,
          },
        },
        member: {
          userId: ctx.principal.userId,
          role,
        },
        agent: { id: ctx.principal.agentId, scopes: [...ctx.principal.scopes] },
      },
      target: { type: 'workspace', id: workspace.id },
    };
  },
});
