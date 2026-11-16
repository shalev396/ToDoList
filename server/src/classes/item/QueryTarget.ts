/**
 * Which query a `POST …/query` request runs (an immutable value object): a saved view's, a
 * dashboard block's (with the page's variables, the block's type, connectors and connector scopes,
 * and the page's importance preset), or a draft sent with the request. The stored ones are read
 * through their classes, behind their rules: View.load (a private view is its owner's alone) and
 * Dashboard.load with Dashboard#pageBlock (a private dashboard too; editors read a dashboard's
 * draft, viewers what was published, DATA.md §3.11). Anything the caller may not see is a 404,
 * like an id that never existed.
 */
import type { Caller } from '../base/Caller.js';
import { QueryValidationError } from '../../builder/errors.js';
import { storedConnectorScopes, storedConnectors } from '../../builder/connectors.js';
import { BLOCK_TYPES, type BlockType, type QueryRequest } from '../../types/builder.js';

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

  /** A saved view's query, as View.load lets the caller see it (a private one: its owner's alone). */
  static async #viewQuery(caller: Caller, viewId: string): Promise<unknown> {
    // Imported on first use, as Topic does: the dashboard classes reach the item classes.
    const { View } = await import('../dashboard/View.js');
    return (await View.load(caller, viewId)).query.toJSON();
  }

  /** A dashboard block's query, as Dashboard.load and Dashboard#pageBlock let the caller see it. */
  static async #block(caller: Caller, dashboardId: string, blockId: string): Promise<QueryTarget> {
    const { Dashboard } = await import('../dashboard/Dashboard.js');
    const dashboard = await Dashboard.load(caller, dashboardId);
    const { index, block, vars, importance } = dashboard.pageBlock(caller, blockId);
    const json = block.toJSON();
    const blockType = BLOCK_TYPES.find((type) => type === block.type);
    const connectors = storedConnectors(json);
    const connectorScopes = storedConnectorScopes(json);
    const target = {
      vars,
      importance,
      ...(blockType === undefined ? {} : { blockType }),
      ...(connectors === undefined ? {} : { connectors }),
      ...(connectorScopes === undefined ? {} : { connectorScopes }),
    };
    if (json.query !== undefined) {
      return new QueryTarget({
        ...target,
        query: json.query,
        pointer: `/blocks/${String(index)}/query`,
      });
    }
    const { savedViewId } = json;
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
