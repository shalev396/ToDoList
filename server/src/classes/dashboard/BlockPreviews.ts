/**
 * A dry run's preview rows (BUILDER.md §9): each block's first rows or groups, run in preview mode
 * (2 s, 20 rows; 5 rows for agents) as the member would see them, with the same `props.*` registry
 * a saved query is run against, so a preview refuses the same paths. A block that cannot run says
 * why instead of failing the dry run.
 */
import { registryOf } from '../../builder/providerFields.js';
import { QueryValidationError } from '../../builder/errors.js';
import { runQuery, type RunQueryDeps } from '../../builder/run.js';
import { getContainerRepository, getItemRepository } from '../../models/index.js';
import { logger } from '../../services/logger.js';
import { CAPS, type DashboardDraft, type QueryResult } from '../../types/builder.js';
import type { BlockPreview } from '../../types/dashboards.js';
import { runWithConcurrency } from '../../utils/concurrency.js';
import type { Caller } from '../base/Caller.js';
import { ProviderFields } from '../item/ProviderFields.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { AttributeDefinitions } from '../workspace/AttributeDefinitions.js';

/** Preview rows per block for agents (small MCP answers); people get CAPS.previewRows. */
const AGENT_PREVIEW_ROWS = 5;
const PREVIEW_CONCURRENCY = 4;

function trim(result: QueryResult, rows: number): QueryResult {
  return {
    ...result,
    ...(result.rows === undefined ? {} : { rows: result.rows.slice(0, rows) }),
    ...(result.groups === undefined ? {} : { groups: result.groups.slice(0, rows) }),
  };
}

function previewError(error: unknown): string {
  if (error instanceof QueryValidationError) return error.message;
  if (typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 50) {
    return 'Query took too long; narrow the filters or date range';
  }
  logger.warn('[dashboards] a block preview failed', error);
  return 'This block could not be previewed';
}

export class BlockPreviews {
  readonly #caller: Caller;

  private constructor(caller: Caller) {
    this.#caller = caller;
    Object.freeze(this);
  }

  /** Previews as the caller sees the workspace. */
  static for(caller: Caller): BlockPreviews {
    return new BlockPreviews(caller);
  }

  /** The reads a preview runs: the compiled pipeline carries the member's access as its first stage. */
  static async #reads(): Promise<RunQueryDeps> {
    const [items, containers] = await Promise.all([getItemRepository(), getContainerRepository()]);
    return {
      items: (workspaceId, stages, options) => items.aggregate(workspaceId, stages, options),
      containers: (workspaceId, stages, options) =>
        containers.aggregate(workspaceId, stages, options),
    };
  }

  /** Each block's first rows or groups: `limit` rows (0 to CAPS.previewRows), 0 for none. */
  async of(draft: DashboardDraft, limit?: number): Promise<Record<string, BlockPreview>> {
    const caller = this.#caller;
    const blocks = draft.blocks.filter((block) => block.query !== undefined);
    if (blocks.length === 0) return {};
    const deps = await BlockPreviews.#reads();
    const ws = caller.context;
    const fieldRegistry = registryOf(await ProviderFields.of(ws, caller.userId));
    const rows = Math.min(
      limit ?? (caller.actor.agentId === null ? CAPS.previewRows : AGENT_PREVIEW_ROWS),
      CAPS.previewRows,
    );
    if (rows <= 0) return {};
    const now = new Date();
    const policy = await ItemPolicy.for({ workspaceId: ws.id, userId: caller.userId });
    const entries = await runWithConcurrency(
      blocks,
      PREVIEW_CONCURRENCY,
      async (block): Promise<[string, BlockPreview]> => {
        if (block.query === undefined) return [block.id, { error: 'This block has no query' }];
        try {
          const result = await runQuery(
            block.query,
            {
              ws: { id: ws.id },
              userId: caller.userId,
              access: policy.access,
              ...(await policy.scopeOf(ws.id, block.connectors, block.connectorScopes)),
              vars: draft.vars,
              now,
              timeZone: ws.settings.timezone,
              weekStart: ws.settings.weekStart,
              preview: true,
              blockType: block.type,
              attributes: AttributeDefinitions.of(ws.settings).toJSON(),
              fieldRegistry,
              ...(draft.importance === undefined ? {} : { importance: draft.importance }),
              ...(block.rules === undefined ? {} : { displayRules: block.rules }),
            },
            deps,
          );
          return [block.id, trim(result, rows)];
        } catch (error) {
          return [block.id, { error: previewError(error) }];
        }
      },
    );
    return Object.fromEntries(entries);
  }
}
