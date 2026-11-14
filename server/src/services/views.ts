/**
 * Saved views (DATA.md §3.13): a named query + visualization that blocks reference by
 * `savedViewId` and `POST /workspaces/:wid/query` runs by `savedQueryId`. Framework-free.
 *
 * Views have no publish step: a published block bound to a view runs the view as it is now.
 * A private view is its owner's alone (404 for everyone else). Every write is validated like a
 * block: the query compiles against the whitelist, the viz fits a catalog type, and nothing in it
 * may look like a secret.
 */
import { BLOCK_CATALOG } from '../builder/catalog.js';
import { compileQuery, parseQuery } from '../builder/compile.js';
import { OpValidationError, QueryValidationError, toPointer } from '../builder/errors.js';
import { validationContext } from '../builder/validate.js';
import { AppError } from '../errors/AppError.js';
import type { ViewData, ViewPatch } from '../models/definitions/View.js';
import { getAuditLogRepository, getViewRepository } from '../models/index.js';
import { BLOCK_TYPES, type Query } from '../types/builder.js';
import type { SavedView } from '../types/dashboards.js';
import { ROLE_RANK, type Visibility } from '../types/domain.js';
import type { WorkspaceContext } from './accessFilter.js';
import type { BuilderActor } from './dashboards.js';
import { findSecrets } from './secretPatterns.js';

export interface CreateViewInput {
  title: string;
  /** Query JSON as sent: validated here. */
  query: unknown;
  viz: Record<string, unknown>;
  visibility?: Visibility | undefined;
}

export interface UpdateViewInput {
  title?: string | undefined;
  query?: unknown;
  viz?: Record<string, unknown> | undefined;
  visibility?: Visibility | undefined;
}

function notFound(): AppError {
  return new AppError(404, 'Not found');
}

function assertEditor(ws: WorkspaceContext, action: string): void {
  if (ROLE_RANK[ws.role] < ROLE_RANK.editor)
    throw new AppError(403, `Only an editor can ${action}`);
}

function visibleTo(view: ViewData, userId: string): boolean {
  return view.visibility === 'workspace' || view.ownerUserId === userId;
}

/** Field by field, so nothing added to ViewData later reaches the API by accident. */
function toSavedView(view: ViewData): SavedView {
  return {
    id: view.id,
    title: view.title,
    query: view.query as Query,
    viz: view.viz,
    visibility: view.visibility,
    ownerUserId: view.ownerUserId,
    createdAt: view.createdAt,
    updatedAt: view.updatedAt,
  };
}

/** The query, parsed and compiled against the whitelist (never run). 400 with a pointer. */
function validQuery(input: unknown): Query {
  try {
    const query = parseQuery(input);
    compileQuery(query, validationContext());
    return query;
  } catch (error) {
    if (error instanceof QueryValidationError) {
      throw new OpValidationError(`/query${error.pointer}`, error.reason);
    }
    throw error;
  }
}

/** The viz must fit a block type that renders its `kind`. 400 with a pointer. */
function validViz(viz: Record<string, unknown>): Record<string, unknown> {
  const { kind } = viz;
  const type = BLOCK_TYPES.find(
    (candidate) => typeof kind === 'string' && BLOCK_CATALOG[candidate].allowedViz.includes(kind),
  );
  if (type === undefined) {
    throw new OpValidationError('/viz/kind', 'not a visualization the catalog knows');
  }
  const parsed = BLOCK_CATALOG[type].vizSchema.safeParse(viz);
  if (!parsed.success) {
    const [first] = parsed.error.issues;
    throw new OpValidationError(
      toPointer(['viz', ...(first?.path ?? [])]),
      first?.message ?? 'invalid',
    );
  }
  return viz;
}

function assertNoSecrets(view: { title?: unknown; query?: unknown; viz?: unknown }): void {
  const [hit] = findSecrets(view);
  if (hit !== undefined) {
    throw new OpValidationError('', 'looks like a secret: saved views never hold secrets');
  }
}

async function audit(
  ws: WorkspaceContext,
  actor: BuilderActor,
  action: string,
  viewId: string,
): Promise<void> {
  await (
    await getAuditLogRepository()
  ).append(ws.id, {
    actorUserId: actor.userId,
    actorAgentId: actor.agentId,
    action,
    targetType: 'view',
    targetId: viewId,
  });
}

async function load(ws: WorkspaceContext, userId: string, id: string): Promise<ViewData> {
  const view = await (await getViewRepository()).findById(ws.id, id);
  if (view === null || !visibleTo(view, userId)) throw notFound();
  return view;
}

/** The views the member can see, by title. */
export async function listViews(ws: WorkspaceContext, userId: string): Promise<SavedView[]> {
  const views = await (await getViewRepository()).list(ws.id);
  return views.filter((view) => visibleTo(view, userId)).map(toSavedView);
}

export async function getView(
  ws: WorkspaceContext,
  userId: string,
  id: string,
): Promise<SavedView> {
  return toSavedView(await load(ws, userId, id));
}

export async function createView(
  ws: WorkspaceContext,
  actor: BuilderActor,
  input: CreateViewInput,
): Promise<SavedView> {
  assertEditor(ws, 'create views');
  const query = validQuery(input.query);
  const viz = validViz(input.viz);
  assertNoSecrets({ title: input.title, query, viz });
  const view = await (
    await getViewRepository()
  ).create(ws.id, {
    ownerUserId: actor.userId,
    title: input.title,
    query,
    viz,
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
  });
  await audit(ws, actor, 'view.create', view.id);
  return toSavedView(view);
}

/** Changes the fields given (a query is validated as on create). Editors; private: owner only. */
export async function updateView(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
  input: UpdateViewInput,
): Promise<SavedView> {
  assertEditor(ws, 'edit views');
  await load(ws, actor.userId, id);
  const patch: ViewPatch = {
    ...(input.title === undefined ? {} : { title: input.title }),
    ...(input.query === undefined ? {} : { query: validQuery(input.query) }),
    ...(input.viz === undefined ? {} : { viz: validViz(input.viz) }),
    ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
  };
  assertNoSecrets(patch);
  const view = await (await getViewRepository()).update(ws.id, id, patch);
  if (view === null) throw notFound();
  await audit(ws, actor, 'view.update', id);
  return toSavedView(view);
}

/** Deletes a view. Blocks bound to it then have nothing to run (their query answers 404). */
export async function deleteView(
  ws: WorkspaceContext,
  actor: BuilderActor,
  id: string,
): Promise<void> {
  assertEditor(ws, 'delete views');
  await load(ws, actor.userId, id);
  if (!(await (await getViewRepository()).delete(ws.id, id))) throw notFound();
  await audit(ws, actor, 'view.delete', id);
}
