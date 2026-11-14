import { z } from 'zod';

import { AppError } from '../../../errors/AppError.js';
import type { IntegrationData } from '../../../models/definitions/Integration.js';
import {
  getAuditLogRepository,
  getIntegrationRepository,
  type AuditLogData,
} from '../../../models/index.js';
import { isOwnIntegration } from '../../../services/integrationOwnership.js';
import { PROVIDERS, type Provider } from '../../../types/domain.js';
import { RESULT_STATUSES, type ResultStatus } from '../../middleware/audit.js';
import { defineTool } from '../../tool.js';

const Entry = z.object({
  id: z.string(),
  at: z.string().describe('ISO 8601'),
  action: z.string().describe('e.g. member.invite, mcp.workspace_get'),
  actorUserId: z.string().describe('A userId, or "system"'),
  actorAgentId: z.string().nullable().describe('The agent key that acted; null for the app'),
  targetType: z.string().nullable(),
  targetId: z
    .string()
    .nullable()
    .describe(
      'null for an event of another member’s integration (its own events, and the items a calendar push wrote): those show only the provider',
    ),
  provider: z
    .enum(PROVIDERS)
    .nullable()
    .describe('The provider of an integration the entry is about; null otherwise'),
  resultStatus: z.enum(RESULT_STATUSES).nullable().describe('MCP calls only'),
});
type Entry = z.infer<typeof Entry>;

/** An opaque page position: the last entry's time and id. */
function encodeCursor(entry: AuditLogData): string {
  return Buffer.from(JSON.stringify({ at: entry.at.toISOString(), id: entry.id }), 'utf8').toString(
    'base64url',
  );
}

function decodeCursor(cursor: string): { at: Date; id: string } {
  try {
    const parsed = JSON.parse(Buffer.from(cursor, 'base64url').toString('utf8')) as unknown;
    const { at, id } = (typeof parsed === 'object' && parsed !== null ? parsed : {}) as {
      at?: unknown;
      id?: unknown;
    };
    const when = typeof at === 'string' ? new Date(at) : null;
    if (when === null || Number.isNaN(when.getTime()) || typeof id !== 'string') {
      throw new Error('shape');
    }
    return { at: when, id };
  } catch {
    throw new AppError(400, 'cursor: invalid; pass the nextCursor of the previous page');
  }
}

function isResultStatus(value: unknown): value is ResultStatus {
  return typeof value === 'string' && (RESULT_STATUSES as readonly string[]).includes(value);
}

function isProvider(value: unknown): value is Provider {
  return typeof value === 'string' && (PROVIDERS as readonly string[]).includes(value);
}

/**
 * The integration an entry is an event of: its target, or for the items a calendar push wrote or
 * deleted (`gcal.*`, target an item) the integration in its meta. Null for anything else.
 */
function integrationIdOf(entry: AuditLogData): string | null {
  if (entry.targetType === 'integration') return entry.targetId;
  const id = entry.meta['integrationId'];
  return entry.targetType === 'item' && typeof id === 'string' ? id : null;
}

/**
 * Who did what, to what, when. Never `meta`: other services keep details there (an invitee's
 * email, say) that not every member may read; MCP entries contribute only their result status.
 * An integration's event shows in full to its owner; to everyone else only as a provider-level
 * event, without the integration's id or the item it wrote (PERMISSIONS-V2 ruling 15).
 */
function toEntry(
  entry: AuditLogData,
  userId: string,
  integrations: ReadonlyMap<string, IntegrationData>,
): Entry {
  const status = entry.meta['resultStatus'];
  const integrationId = integrationIdOf(entry);
  const about = integrationId === null ? undefined : integrations.get(integrationId);
  const isIntegration = entry.targetType === 'integration' || integrationId !== null;
  const mine = about !== undefined && isOwnIntegration(about, userId);
  const metaProvider = entry.meta['provider'];
  return {
    id: entry.id,
    at: entry.at.toISOString(),
    action: entry.action,
    actorUserId: entry.actorUserId,
    actorAgentId: entry.actorAgentId,
    targetType: entry.targetType,
    targetId: isIntegration && !mine ? null : entry.targetId,
    provider: isIntegration
      ? (about?.provider ?? (isProvider(metaProvider) ? metaProvider : null))
      : null,
    resultStatus: entry.action.startsWith('mcp.') && isResultStatus(status) ? status : null,
  };
}

export const auditLogQuery = defineTool({
  name: 'audit_log_query',
  title: 'Query the audit log',
  description:
    'Recent actions in the workspace, newest first: the action, the member and agent key that did it, its target and time, and for agent calls the result status. Events about the key user’s own integrations come in full; other members’ show only their provider. Filter by agent key, action or start time; page with cursor and nextCursor.',
  toolset: 'workspace',
  inputSchema: z.strictObject({
    agentId: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only actions by this agent key (workspace_get returns this key’s id)'),
    action: z
      .string()
      .min(1)
      .max(100)
      .optional()
      .describe('Only this exact action, e.g. "mcp.workspace_invite" or "member.remove"'),
    since: z.iso
      .datetime({ offset: true })
      .optional()
      .describe('Only actions at or after this time (ISO 8601)'),
    limit: z.number().int().min(1).max(100).default(25),
    cursor: z.string().min(1).max(500).optional().describe('The nextCursor of the previous page'),
  }),
  outputSchema: z.object({
    entries: z.array(Entry),
    nextCursor: z
      .string()
      .nullable()
      .describe('Pass it as cursor for the next page; null at the end'),
  }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['workspace:read'],
  minRole: 'viewer',
  async handler(ctx, input) {
    const auditLogs = await getAuditLogRepository();
    const rows = await auditLogs.list(
      ctx.workspace.id,
      {
        ...(input.agentId === undefined ? {} : { actorAgentId: input.agentId }),
        ...(input.action === undefined ? {} : { action: input.action }),
        ...(input.since === undefined ? {} : { since: new Date(input.since) }),
        ...(input.cursor === undefined ? {} : { before: decodeCursor(input.cursor) }),
      },
      input.limit + 1,
    );
    const page = rows.slice(0, input.limit);
    const last = page[page.length - 1];
    const ids = [
      ...new Set(
        page.flatMap((entry) => {
          const id = integrationIdOf(entry);
          return id === null ? [] : [id];
        }),
      ),
    ];
    const integrations = new Map(
      (
        await (await getIntegrationRepository()).listByIdsIncludingDeleted(ctx.workspace.id, ids)
      ).map((integration) => [integration.id, integration]),
    );
    return {
      output: {
        entries: page.map((entry) => toEntry(entry, ctx.principal.userId, integrations)),
        nextCursor: rows.length > input.limit && last !== undefined ? encodeCursor(last) : null,
      },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
