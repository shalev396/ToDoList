/**
 * Saved views (DATA.md §3.13): a named query and visualization that blocks reference by
 * `savedViewId` and `POST /workspaces/:wid/query` runs by `savedQueryId`. The only code that
 * writes Views.
 *
 * Views have no publish step: a published block bound to a view runs the view as it is now. A
 * private view is its owner's alone (404 for everyone else). Every write is validated like a
 * block: the query compiles against the whitelist (Query), the viz fits a catalog type, and
 * nothing in it may look like a secret. Each operation's role is checked before the view is read
 * (403 before 404, as always).
 */
import { BLOCK_CATALOG } from '../../builder/catalog.js';
import { OpValidationError, toPointer } from '../../builder/errors.js';
import { AppError } from '../../errors/AppError.js';
import type { ViewData, ViewPatch } from '../../models/definitions/View.js';
import { getViewRepository } from '../../models/index.js';
import { findSecrets } from '../../services/secretPatterns.js';
import { BLOCK_TYPES } from '../../types/builder.js';
import type { SavedView } from '../../types/dashboards.js';
import type { Visibility } from '../../types/domain.js';
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, Owned, Viewable } from '../base/contracts.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { AuditLog } from '../AuditLog.js';
import { Operation } from './Operation.js';
import { Query } from './Query.js';

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

export class View
  extends WorkspaceEntity<ViewData>
  implements Owned, Auditable, Viewable<SavedView>
{
  /** The audit action names a view writes. */
  static readonly Audit = Object.freeze({
    create: 'view.create',
    update: 'view.update',
    delete: 'view.delete',
  });

  /** What each operation needs of the caller's role, checked before the view is read. */
  static readonly Operation = Object.freeze({
    read: Operation.member('see views'),
    create: Operation.of('editor', 'create views'),
    edit: Operation.of('editor', 'edit views'),
    delete: Operation.of('editor', 'delete views'),
  });

  readonly #query: Query;

  private constructor(data: ViewData) {
    super(data);
    this.#query = Query.from(data.query);
  }

  get title(): string {
    return this.data.title;
  }

  get query(): Query {
    return this.#query;
  }

  get viz(): Readonly<Record<string, unknown>> {
    return this.data.viz;
  }

  get visibility(): Visibility {
    return this.data.visibility;
  }

  get ownerUserId(): string {
    return this.data.ownerUserId;
  }

  isOwnedBy(userId: string): boolean {
    return this.data.ownerUserId === userId;
  }

  /** Shared with the workspace, or the member's own. */
  isVisibleTo(userId: string): boolean {
    return this.data.visibility === 'workspace' || this.isOwnedBy(userId);
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('view', this.id);
  }

  /** Field by field, so nothing added to ViewData later reaches the API by accident. */
  toView(): SavedView {
    const view = this.toJSON();
    return {
      id: view.id,
      title: view.title,
      query: this.#query.toJSON(),
      viz: view.viz,
      visibility: view.visibility,
      ownerUserId: view.ownerUserId,
      createdAt: view.createdAt,
      updatedAt: view.updatedAt,
    };
  }

  // ─── Loading ───────────────────────────────────────────────────────────────

  /** The views the member can see, by title. */
  static async list(caller: Caller): Promise<View[]> {
    const views = await (await getViewRepository()).list(caller.workspaceId);
    return views.map((data) => new View(data)).filter((view) => view.isVisibleTo(caller.userId));
  }

  /**
   * The view, as the caller may see it: 403 first unless the caller's role allows `operation`,
   * then 404 when it doesn't exist (or is another member's private one).
   */
  static async load(
    caller: Caller,
    id: string,
    operation: Operation = View.Operation.read,
  ): Promise<View> {
    operation.assert(caller);
    const data = await (await getViewRepository()).findById(caller.workspaceId, id);
    if (data === null) throw notFound();
    const view = new View(data);
    if (!view.isVisibleTo(caller.userId)) throw notFound();
    return view;
  }

  // ─── Writes ────────────────────────────────────────────────────────────────

  /** Editors and owners: a new view of the caller's. */
  static async create(caller: Caller, input: CreateViewInput): Promise<View> {
    View.Operation.create.assert(caller);
    const query = Query.parse(input.query).toJSON();
    const viz = validViz(input.viz);
    assertNoSecrets({ title: input.title, query, viz });
    const view = new View(
      await (
        await getViewRepository()
      ).create(caller.workspaceId, {
        ownerUserId: caller.actor.userId,
        title: input.title,
        query,
        viz,
        ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
      }),
    );
    await AuditLog.record(caller, View.Audit.create, view);
    return view;
  }

  /** Changes the fields given (a query is validated as on create). Editors; private: owner only. */
  async update(caller: Caller, input: UpdateViewInput): Promise<View> {
    this.#allow(caller, View.Operation.edit);
    const patch: ViewPatch = {
      ...(input.title === undefined ? {} : { title: input.title }),
      ...(input.query === undefined ? {} : { query: Query.parse(input.query).toJSON() }),
      ...(input.viz === undefined ? {} : { viz: validViz(input.viz) }),
      ...(input.visibility === undefined ? {} : { visibility: input.visibility }),
    };
    assertNoSecrets(patch);
    const updated = await (await getViewRepository()).update(this.workspaceId, this.id, patch);
    if (updated === null) throw notFound();
    await AuditLog.record(caller, View.Audit.update, this);
    return new View(updated);
  }

  /** Deletes the view. Blocks bound to it then have nothing to run (their query answers 404). */
  async delete(caller: Caller): Promise<void> {
    this.#allow(caller, View.Operation.delete);
    if (!(await (await getViewRepository()).delete(this.workspaceId, this.id))) throw notFound();
    await AuditLog.record(caller, View.Audit.delete, this);
  }

  /** The operation's role (403), then the caller sees this view (404), as `load` checked. */
  #allow(caller: Caller, operation: Operation): void {
    operation.assert(caller);
    this.assertIn(caller);
    if (!this.isVisibleTo(caller.userId)) throw notFound();
  }

  // ─── A workspace's end ─────────────────────────────────────────────────────

  /** Deletes every view of a workspace (its deletion; refuses a live one). Returns how many. */
  static async removeAllIn(workspaceId: string): Promise<number> {
    const { Workspace } = await import('../workspace/Workspace.js');
    await Workspace.requireEnded(workspaceId);
    return (await getViewRepository()).deleteForWorkspace(workspaceId);
  }

  /** Every workspace id a view names (the purge's orphan sweep). Global. */
  static async referencedWorkspaceIds(): Promise<string[]> {
    return (await getViewRepository()).listWorkspaceIds();
  }
}
