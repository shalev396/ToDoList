/**
 * The screen a tools/call passes before the SDK sees it, on HTTP and on stdio alike. The server
 * lists only the tools a principal may call, so a call to any other name is refused here, with a
 * plain JSON-RPC error, and audited (the SDK would only say "not found", and audit nothing):
 * - a name that is not in the catalog: `mcp.unknown_tool`, `refused` (the name itself is only
 *   hashed with the arguments: it is free text from the agent);
 * - a catalog tool past the key's scopes or role, or a write on the read-only endpoint: `denied`.
 */
import type { AgentPrincipal } from './auth/principal.js';
import { canCall } from './auth/scopes.js';
import { JSON_RPC, methodOf } from './jsonRpc.js';
import { recordToolCall } from './middleware/audit.js';
import { findTool, toolAccess } from './registry.js';

/** The audit name of a call to a tool the catalog doesn't have. */
export const UNKNOWN_TOOL = 'unknown_tool';

export interface Refusal {
  code: number;
  message: string;
}

/** The tool name and arguments of a single tools/call message, or null. */
export function toolCallOf(body: unknown): { name: string; args: unknown } | null {
  if (methodOf(body) !== 'tools/call') return null;
  const { params } = body as { params?: unknown };
  if (typeof params !== 'object' || params === null) return null;
  const { name, arguments: args } = params as { name?: unknown; arguments?: unknown };
  return typeof name === 'string' ? { name, args } : null;
}

/** Null when the message may go on to the server; otherwise the error to answer with. */
export async function screenToolCall(
  body: unknown,
  principal: AgentPrincipal,
  readonly: boolean,
): Promise<Refusal | null> {
  const call = toolCallOf(body);
  if (call === null) return null;
  const tool = findTool(call.name);
  if (tool === undefined) {
    await recordToolCall(
      principal,
      UNKNOWN_TOOL,
      { name: call.name, arguments: call.args },
      'refused',
    );
    return {
      code: JSON_RPC.invalidParams,
      message: 'Unknown tool: no tool by that name is served here (tools/list shows them).',
    };
  }
  if (canCall(toolAccess(tool), principal, { readonly })) return null;
  await recordToolCall(principal, tool.name, call.args, 'denied');
  return {
    code: JSON_RPC.invalidParams,
    message:
      readonly && !tool.annotations.readOnlyHint
        ? `Tool ${tool.name} changes data and is not served on the read-only endpoint.`
        : `Tool ${tool.name} needs a scope or role this agent key does not have.`,
  };
}
