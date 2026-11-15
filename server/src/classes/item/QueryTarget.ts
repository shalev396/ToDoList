/**
 * Which query a `POST …/query` request runs (an immutable value object): a saved view's, a
 * dashboard block's (with the page's variables, the block's type, connectors and connector scopes,
 * and the page's importance preset), or a draft sent with the request. The stored ones are read
 * here, behind their own rules: a private view or dashboard is its owner's alone, and editors read
 * a dashboard's draft while viewers read what was published (DATA.md §3.11). Anything the caller
 * may not see is a 404, like an id that never existed. (Phase 6's Dashboard and View classes take
 * these reads over.)
 */
import type { Caller } from '../base/Caller.js';
import { Role } from '../base/Role.js';
import { DashboardPolicy } from '../policies/DashboardPolicy.js';
import { QueryValidationError } from '../../builder/errors.js';
import { storedConnectorScopes, storedConnectors } from '../../builder/connectors.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { getDashboardRepository, getViewRepository } from '../../models/index.js';
import { BLOCK_TYPES, type BlockType, type QueryRequest } from '../../types/builder.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** What a request's query is, and where it sits (for error pointers). */
export interface QueryTargetData {
  /** Query JSON as stored or sent: the compiler validates it. */
  readonly query: unknown;
  /** Where the query sits in its document (request, dashboard or view), for error pointers. */
  readonly pointer: string;
  /** Page-variable defaults: the dashboard's vars. */
  readonly vars: Readonly<Record<string, unknown>>;
  readonly blockType?: BlockType;
  /** The block's (or the draft's) connectors: only these sources are read (empty: none). */
  readonly connectors?: readonly string[];
  /** The block's (or the draft's) connector scopes: the containers a connector narrows to. */
  readonly connectorScopes?: Readonly<Record<string, readonly string[]>>;
  /** The page's importance preset, as stored (checked before use). */
  readonly importance?: unknown;
}

export class QueryTarget {
  readonly #data: QueryTargetData;

  private constructor(data: QueryTargetData) {
    this.#data = Object.freeze({ ...data });
    Object.freeze(this);
  }

  /** The request's target: a draft, a saved view, or a dashboard block (400 for none of those). */
  static async resolve(caller: Caller, request: QueryRequest): Promise<QueryTarget> {
    if (request.draft !== undefined) {
      const { blockType, connectors, connectorScopes } = request;
      return new QueryTarget({
        query: request.draft,
        pointer: '/draft',
        vars: {},
        importance: request.importance,
        ...(blockType === undefined ? {} : { blockType }),
        ...(connectors === undefined ? {} : { connectors }),
        ...(connectorScopes === undefined ? {} : { connectorScopes }),
      });
    }
    if (request.savedQueryId !== undefined) {
      const query = await QueryTarget.#viewQuery(caller, request.savedQueryId);
      return new QueryTarget({ query, pointer: '/query', vars: {} });
    }
    const { dashboardId, blockId } = request;
    if (dashboardId === undefined || blockId === undefined) {
      throw new QueryValidationError(
        '',
        'send exactly one of savedQueryId, dashboardId + blockId, or draft',
      );
    }
    return QueryTarget.#block(caller, dashboardId, blockId);
  }

  get data(): QueryTargetData {
    return this.#data;
  }

  /** A saved view's query; a private one is its owner's alone (404). */
  static async #viewQuery(caller: Caller, viewId: string): Promise<unknown> {
    const view = await (await getViewRepository()).findById(caller.workspaceId, viewId);
    if (view === null || (view.visibility !== 'workspace' && view.ownerUserId !== caller.userId)) {
      throw new NotFoundError();
    }
    return view.query;
  }

  static async #block(caller: Caller, dashboardId: string, blockId: string): Promise<QueryTarget> {
    const dashboard = await (
      await getDashboardRepository()
    ).findById(caller.workspaceId, dashboardId);
    if (dashboard === null || !caller.can(DashboardPolicy.instance, 'read', dashboard)) {
      throw new NotFoundError();
    }
    // Editors work on the draft; viewers see what was published (DATA.md §3.11).
    const config = caller.role.atLeast(Role.editor) ? dashboard : dashboard.published;
    if (config === null) throw new NotFoundError();
    const index = config.blocks.findIndex((block) => isRecord(block) && block['id'] === blockId);
    const block = config.blocks[index];
    if (!isRecord(block)) throw new NotFoundError();

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
      return new QueryTarget({
        ...target,
        query: block['query'],
        pointer: `/blocks/${String(index)}/query`,
      });
    }
    const savedViewId = block['savedViewId'];
    if (typeof savedViewId === 'string') {
      return new QueryTarget({
        ...target,
        query: await QueryTarget.#viewQuery(caller, savedViewId),
        pointer: '/query',
      });
    }
    throw new QueryValidationError(`/blocks/${String(index)}`, 'this block has no query');
  }
}
