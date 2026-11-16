/**
 * The secret guard for MCP (MCP.md §5.4, DATA.md §0.4). MCP answers are JSON-RPC, not the REST
 * `{data}` envelope, so res.success's guard never sees them: the same findSecrets check runs here
 * over every tool result and error, with the same per-environment behaviour: a hit throws
 * SecretLeakError on dev and qa (the bug is loud) and becomes a generic error on prod. Reports and
 * logs name a path and a kind, never the value.
 */
import { environment } from '../../config/environment.js';
import { SecretLeakError } from '../../errors/AppError.js';
import { logger } from '../../services/logger.js';
import { findSecrets } from '../../services/secretPatterns.js';
import type { Env } from '../../types/env.d.ts';

/**
 * Checks one outgoing value. Clean: returns false. A hit: logs where (paths and kinds only), then
 * throws SecretLeakError, or on prod returns true so the caller answers a generic error instead.
 */
export function blockSecrets(value: unknown, what: string, env: Env = environment.env): boolean {
  const hits = findSecrets(value);
  if (hits.length === 0) return false;
  logger.error(`[secret-guard] blocked ${what}`, { hits });
  if (env !== 'prod') throw new SecretLeakError(hits.map((hit) => `${hit.path} (${hit.kind})`));
  return true;
}
