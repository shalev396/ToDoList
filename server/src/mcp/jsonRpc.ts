/**
 * JSON-RPC 2.0 error bodies for the answers the MCP router gives itself, before or around the SDK
 * (401, 429, unsupported requests, a blocked response). Messages are fixed text: nothing a client
 * sent is echoed back.
 */

/** Server-defined codes (JSON-RPC reserves -32000…-32099 for them) and the standard ones used. */
export const JSON_RPC = {
  parseError: -32700,
  invalidRequest: -32600,
  methodNotFound: -32601,
  invalidParams: -32602,
  internalError: -32603,
  serverError: -32000,
  unauthorized: -32001,
  rateLimited: -32002,
} as const;

export type JsonRpcId = string | number | null;

export interface JsonRpcErrorBody {
  jsonrpc: '2.0';
  id: JsonRpcId;
  error: { code: number; message: string };
}

export function jsonRpcError(id: JsonRpcId, code: number, message: string): JsonRpcErrorBody {
  return { jsonrpc: '2.0', id, error: { code, message } };
}

/** The id of a single JSON-RPC request body, or null (a notification, a batch, not JSON-RPC). */
export function requestIdOf(body: unknown): JsonRpcId {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { id } = body as { id?: unknown };
  return typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id)) ? id : null;
}

/** The method of a single JSON-RPC message body, or null. */
export function methodOf(body: unknown): string | null {
  if (typeof body !== 'object' || body === null || Array.isArray(body)) return null;
  const { method } = body as { method?: unknown };
  return typeof method === 'string' ? method : null;
}
