/**
 * `POST /workspaces/:wid/query` (BACKEND.md §4) for one caller, framework-free so MCP tools can
 * reuse it: picks the query (QueryTarget: a saved view, a dashboard block, or a draft), merges the
 * page variables and runs it through the Logic Bridge with the caller's access (ItemQuery:
 * share-on-attach, effective values). A block reads only its connectors, each record once
 * (blockScope). No database here: the reads are the classes'.
 *
 * Errors are AppErrors: 400 for an invalid request or query (a JSON pointer and a reason, never a
 * value), 404 for a dashboard, block or view the caller cannot see.
 */
import { assertSafeInput, parseQuery, type CompileContext } from '../builder/compile.js';
import { QueryValidationError, fromZodError, toPointer } from '../builder/errors.js';

import { AppError } from '../errors/AppError.js';
import {
  QueryRequestSchema,
  VAR_REF_PREFIX,
  type QueryRequest,
  type QueryResult,
} from '../types/builder.js';
import { ImportanceConfigSchema, type ImportanceConfig } from '../types/importance.js';
import { Actor } from '../classes/base/Actor.js';
import { Caller, type WorkspaceContext } from '../classes/base/Caller.js';
import type { ItemPolicy } from '../classes/policies/ItemPolicy.js';
import { ItemQuery, ProviderFields, QueryTarget } from '../classes/item/index.js';
import { AttributeDefinitions } from '../classes/workspace/AttributeDefinitions.js';
import { registryOf } from '../builder/providerFields.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Page variables keyed by bare name: `$page.area` → `area`. */
function bareVars(vars: Record<string, unknown>): Record<string, unknown> {
  return Object.fromEntries(
    Object.entries(vars).map(([key, value]) => [
      key.startsWith(VAR_REF_PREFIX) ? key.slice(VAR_REF_PREFIX.length) : key,
      value,
    ]),
  );
}

function parseRequest(body: unknown): QueryRequest {
  // Depth first (vars keys legitimately start with `$page.`), then $-keys where they never belong.
  assertSafeInput(body, '', { allowDollarKeys: true });
  if (isRecord(body)) {
    assertSafeInput(body['draft'], '/draft');
    const vars = isRecord(body['vars']) ? body['vars'] : {};
    for (const [name, value] of Object.entries(vars)) {
      assertSafeInput(value, `/vars${toPointer([name])}`);
    }
  }
  const parsed = QueryRequestSchema.safeParse(body);
  if (!parsed.success) throw fromZodError(parsed.error);
  return parsed.data;
}

/** A stored importance preset when it is well-formed; anything else reads as the default. */
function importanceOf(stored: unknown): ImportanceConfig | undefined {
  const parsed = ImportanceConfigSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

/**
 * Runs one query request (`body` as received) for `userId` in `workspace`. Request vars override
 * the dashboard's default vars; time zone and week start come from the workspace settings.
 * `policy` defaults to what `userId` may see (ItemPolicy.for).
 */
export async function runWorkspaceQuery(
  workspace: WorkspaceContext,
  userId: string,
  body: unknown,
  now: Date = new Date(),
  policy?: ItemPolicy,
): Promise<QueryResult> {
  let pointer = '';
  try {
    const request = parseRequest(body);
    const caller = Caller.fromContext(workspace, Actor.user(userId));
    const target = (await QueryTarget.resolve(caller, request)).data;
    pointer = target.pointer;
    const query = parseQuery(target.query);
    const reads = policy === undefined ? await ItemQuery.for(caller) : ItemQuery.of(caller, policy);
    const seen = reads.policy;
    const importance = importanceOf(target.importance);
    const ctx: CompileContext = {
      ws: workspace,
      userId,
      access: seen.access,
      ...(await seen.scopeOf(workspace.id, target.connectors, target.connectorScopes)),
      vars: { ...bareVars(target.vars), ...bareVars(request.vars ?? {}) },
      now,
      timeZone: workspace.settings.timezone,
      weekStart: workspace.settings.weekStart,
      preview: request.preview ?? false,
      attributes: AttributeDefinitions.of(workspace.settings).toJSON(),
      ...(importance === undefined ? {} : { importance }),
      ...(JSON.stringify(query).includes('props.')
        ? { fieldRegistry: registryOf(await ProviderFields.of(workspace, userId, now.getTime())) }
        : {}),
      ...(target.blockType === undefined ? {} : { blockType: target.blockType }),
      ...(target.includeTomorrow === true ? { includeTomorrow: true } : {}),
    };
    return await reads.run(query, ctx);
  } catch (error) {
    if (error instanceof QueryValidationError)
      throw new AppError(400, error.under(pointer).message);
    throw error;
  }
}
