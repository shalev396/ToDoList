/**
 * `POST /workspaces/:wid/query` (BACKEND.md §4) for one caller, framework-free so MCP tools can
 * reuse it: picks the query (a saved view, a dashboard block, or a draft), merges the page
 * variables and runs it through the Logic Bridge with the caller's access (share-on-attach,
 * itemAccess.ts). A block reads only its connectors, each record once (blockScope).
 *
 * Errors are AppErrors: 400 for an invalid request or query (a JSON pointer and a reason, never a
 * value), 404 for a dashboard, block or view the caller cannot see.
 */
import { storedConnectorScopes, storedConnectors } from '../builder/connectors.js';
import { assertSafeInput, parseQuery, type CompileContext } from '../builder/compile.js';
import { QueryValidationError, fromZodError, toPointer } from '../builder/errors.js';
import { runQuery, type RunQueryDeps } from '../builder/run.js';
import mongoose from 'mongoose';

import { AppError } from '../errors/AppError.js';
import {
  getContainerRepository,
  getDashboardRepository,
  getItemRepository,
  getViewRepository,
} from '../models/index.js';
import {
  BLOCK_TYPES,
  QueryRequestSchema,
  VAR_REF_PREFIX,
  type BlockType,
  type QueryRequest,
  type QueryResult,
} from '../types/builder.js';
import { ImportanceConfigSchema, type ImportanceConfig } from '../types/importance.js';
import type { Visibility } from '../types/domain.js';
import { Actor } from '../classes/base/Actor.js';
import { Caller, type WorkspaceContext } from '../classes/base/Caller.js';
import { Role } from '../classes/base/Role.js';
import { DashboardPolicy } from '../classes/policies/DashboardPolicy.js';
import { ItemPolicy } from '../classes/policies/ItemPolicy.js';
import { AttributeDefinitions } from '../classes/workspace/AttributeDefinitions.js';
import { logger } from './logger.js';
import { providerFieldsOf, registryOf } from './providerFields.js';

/** MongoDB's MaxTimeMSExpired. */
const MAX_TIME_MS_EXPIRED = 50;

interface QueryTarget {
  /** Query JSON as stored or sent: the compiler validates it. */
  query: unknown;
  /** Where the query sits in its document (request, dashboard or view), for error pointers. */
  pointer: string;
  /** Page-variable defaults: the dashboard's vars. */
  vars: Record<string, unknown>;
  blockType?: BlockType;
  /** The block's (or the draft's) connectors: only these sources are read (empty: none). */
  connectors?: readonly string[];
  /** The block's (or the draft's) connector scopes: the containers a connector narrows to. */
  connectorScopes?: Readonly<Record<string, readonly string[]>>;
  /** The page's importance preset, as stored (checked before use). */
  importance?: unknown;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function notFound(): AppError {
  return new AppError(404, 'Not found');
}

/** Private views and dashboards belong to their owner alone. */
function visibleTo(
  document: { visibility: Visibility; ownerUserId: string },
  userId: string,
): boolean {
  return document.visibility === 'workspace' || document.ownerUserId === userId;
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

async function viewQuery(workspaceId: string, userId: string, viewId: string): Promise<unknown> {
  const views = await getViewRepository();
  const view = await views.findById(workspaceId, viewId);
  if (view === null || !visibleTo(view, userId)) throw notFound();
  return view.query;
}

async function blockQuery(
  workspace: WorkspaceContext,
  userId: string,
  dashboardId: string,
  blockId: string,
): Promise<QueryTarget> {
  const dashboards = await getDashboardRepository();
  const dashboard = await dashboards.findById(workspace.id, dashboardId);
  const caller = Caller.fromContext(workspace, Actor.user(userId));
  if (dashboard === null || !caller.can(DashboardPolicy.instance, 'read', dashboard)) {
    throw notFound();
  }
  // Editors work on the draft; viewers see what was published (DATA.md §3.11).
  const config = caller.role.atLeast(Role.editor) ? dashboard : dashboard.published;
  if (config === null) throw notFound();
  const index = config.blocks.findIndex((block) => isRecord(block) && block['id'] === blockId);
  const block = config.blocks[index];
  if (!isRecord(block)) throw notFound();

  const blockType = BLOCK_TYPES.find((type) => type === block['type']);
  const connectors = storedConnectors(block);
  const connectorScopes = storedConnectorScopes(block);
  const target = {
    vars: config.vars,
    importance: config.importance,
    ...(blockType === undefined ? {} : { blockType }),
    ...(connectors === undefined ? {} : { connectors }),
    ...(connectorScopes === undefined ? {} : { connectorScopes }),
  };
  if (block['query'] !== undefined) {
    return { ...target, query: block['query'], pointer: `/blocks/${String(index)}/query` };
  }
  const savedViewId = block['savedViewId'];
  if (typeof savedViewId === 'string') {
    return {
      ...target,
      query: await viewQuery(workspace.id, userId, savedViewId),
      pointer: '/query',
    };
  }
  throw new QueryValidationError(`/blocks/${String(index)}`, 'this block has no query');
}

async function resolveTarget(
  workspace: WorkspaceContext,
  userId: string,
  request: QueryRequest,
): Promise<QueryTarget> {
  if (request.draft !== undefined) {
    const { blockType, connectors, connectorScopes } = request;
    return {
      query: request.draft,
      pointer: '/draft',
      vars: {},
      importance: request.importance,
      ...(blockType === undefined ? {} : { blockType }),
      ...(connectors === undefined ? {} : { connectors }),
      ...(connectorScopes === undefined ? {} : { connectorScopes }),
    };
  }
  if (request.savedQueryId !== undefined) {
    const query = await viewQuery(workspace.id, userId, request.savedQueryId);
    return { query, pointer: '/query', vars: {} };
  }
  const { dashboardId, blockId } = request;
  if (dashboardId === undefined || blockId === undefined) {
    throw new QueryValidationError(
      '',
      'send exactly one of savedQueryId, dashboardId + blockId, or draft',
    );
  }
  return blockQuery(workspace, userId, dashboardId, blockId);
}

/** A stored importance preset when it is well-formed; anything else reads as the default. */
function importanceOf(stored: unknown): ImportanceConfig | undefined {
  const parsed = ImportanceConfigSchema.safeParse(stored);
  return parsed.success ? parsed.data : undefined;
}

async function repositoryDeps(): Promise<RunQueryDeps> {
  const [items, containers] = await Promise.all([getItemRepository(), getContainerRepository()]);
  return {
    items: (workspaceId, stages, options) => items.aggregate(workspaceId, stages, options),
    containers: (workspaceId, stages, options) =>
      containers.aggregate(workspaceId, stages, options),
  };
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
    const target = await resolveTarget(workspace, userId, request);
    pointer = target.pointer;
    const query = parseQuery(target.query);
    const seen = policy ?? (await ItemPolicy.for({ workspaceId: workspace.id, userId }));
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
        ? { fieldRegistry: registryOf(await providerFieldsOf(workspace, userId, now.getTime())) }
        : {}),
      ...(target.blockType === undefined ? {} : { blockType: target.blockType }),
    };
    return await runQuery(query, ctx, await repositoryDeps());
  } catch (error) {
    if (error instanceof QueryValidationError)
      throw new AppError(400, error.under(pointer).message);
    if (error instanceof mongoose.mongo.MongoServerError && error.code === MAX_TIME_MS_EXPIRED) {
      logger.warn('Query hit its time limit', { workspaceId: workspace.id });
      throw new AppError(503, 'Query took too long; narrow the filters or date range');
    }
    throw error;
  }
}
