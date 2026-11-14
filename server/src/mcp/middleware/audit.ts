/**
 * One AuditLogs entry per tool call (MCP.md §5.5, DATA.md §3.10): the user and the agent key that
 * acted, `action: "mcp.<tool>"`, the target, and `meta: {argsHash, resultStatus}`. The arguments
 * themselves are never stored, only a hash of them.
 */
import { createHash } from 'node:crypto';

import { getAuditLogRepository } from '../../models/index.js';
import { logger } from '../../services/logger.js';
import type { AgentPrincipal } from '../auth/principal.js';
import type { AuditTarget } from '../tool.js';

/**
 * ok: done. preview: a destructive tool ran without `confirm`, nothing changed. error: refused by
 * a rule, invalid, or failed. denied: the key may not call the tool here. refused: the server
 * would not run the call at all (no such tool, or arguments over the input limits). blocked: the
 * answer carried secret-shaped data and was withheld.
 */
export const RESULT_STATUSES = ['ok', 'preview', 'error', 'denied', 'refused', 'blocked'] as const;
export type ResultStatus = (typeof RESULT_STATUSES)[number];

/** Keys sorted at every depth, so the same arguments always serialize, and hash, the same. */
function canonical(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(canonical);
  if (typeof value !== 'object' || value === null || value instanceof Date) return value;
  return Object.fromEntries(
    Object.keys(value)
      .sort()
      .map((key) => [key, canonical((value as Record<string, unknown>)[key])]),
  );
}

/** Hex SHA-256 of the canonical JSON of the arguments. */
export function argsHash(args: unknown): string {
  return createHash('sha256')
    .update(JSON.stringify(canonical(args ?? {})))
    .digest('hex');
}

/** Extra meta keys a tool may add: plain names, short string values, never the fixed two. */
const META_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const META_VALUE_MAX = 200;

function extraMeta(meta: Record<string, string> | undefined): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [key, value] of Object.entries(meta ?? {})) {
    if (key === 'argsHash' || key === 'resultStatus' || !META_KEY.test(key)) continue;
    if (value.length <= META_VALUE_MAX) out[key] = value;
  }
  return out;
}

/** How an outcome asked to be audited (ToolOutcome.audit). */
export interface AuditExtra {
  /** Another tool name to record the call under, e.g. builder_preview for a dry run. */
  action?: string | undefined;
  meta?: Record<string, string> | undefined;
}

/**
 * Appends the entry. A failed write is logged and does not fail the call: by then the call has
 * happened, and answering an error would invite the agent to repeat it.
 */
export async function recordToolCall(
  principal: AgentPrincipal,
  tool: string,
  args: unknown,
  status: ResultStatus,
  target?: AuditTarget,
  extra: AuditExtra = {},
): Promise<void> {
  try {
    const auditLogs = await getAuditLogRepository();
    await auditLogs.append(principal.workspaceId, {
      actorUserId: principal.userId,
      actorAgentId: principal.agentId,
      action: `mcp.${extra.action ?? tool}`,
      targetType: target?.type ?? 'workspace',
      targetId: target?.id ?? principal.workspaceId,
      meta: { argsHash: argsHash(args), resultStatus: status, ...extraMeta(extra.meta) },
    });
  } catch (error) {
    logger.error(`[mcp] the audit entry for ${tool} could not be written`, error);
  }
}
