import { keepPreviousData, queryOptions, skipToken } from '@tanstack/react-query';
import type { Block, QueryVars } from '@api-types/builder.ts';
import { selectBlockVars, varsHash } from '../../features/dashboards/variables/blockVars.ts';
import type { PageVars } from '../../features/dashboards/variables/urlVars.ts';
import { queryKeys } from './keys.ts';
import { QUERY_STALE_TIME_PRIVATE_MS } from './queryOptions.ts';

/** The `/query` body for one block of a stored dashboard. */
export interface BlockQueryBody {
  dashboardId: string;
  blockId: string;
  vars: QueryVars;
}

/** A block whose data comes from `/query`: an embedded query or a saved view. */
export function blockHasData(block: Pick<Block, 'query' | 'savedViewId'>): boolean {
  return block.query !== undefined || (block.savedViewId ?? null) !== null;
}

interface BlockQueryInput<TData> {
  /** Null until the workspace is known: nothing is fetched. */
  workspaceId: string | null;
  dashboardId: string;
  block: Pick<Block, 'id' | 'listen' | 'query' | 'savedViewId'> &
    Partial<Pick<Block, 'type' | 'rules'>>;
  /** The page's variables; only the block's own are sent and keyed. */
  vars: PageVars;
  /** The block's registry entry's interval (the clock and calendar: every minute). */
  refetchIntervalMs: number | undefined;
  run: (workspaceId: string, body: BlockQueryBody, signal: AbortSignal) => Promise<TData>;
}

/** The query behind `useBlockData` (api/queries/blocks.ts), which explains each choice. */
export function blockQueryOptions<TData>({
  workspaceId,
  dashboardId,
  block,
  vars,
  refetchIntervalMs,
  run,
}: BlockQueryInput<TData>) {
  const selected = selectBlockVars(block, vars);
  return queryOptions({
    queryKey: queryKeys.block(workspaceId ?? '', dashboardId, block.id, varsHash(selected)),
    staleTime: QUERY_STALE_TIME_PRIVATE_MS,
    // FRONTEND.md §6 "Freshness": block results, unlike the app's other queries, catch up when
    // the window comes back (once stale).
    refetchOnWindowFocus: true,
    refetchInterval: refetchIntervalMs ?? false,
    placeholderData: keepPreviousData,
    queryFn:
      workspaceId === null || !blockHasData(block)
        ? skipToken
        : ({ signal }) =>
            run(workspaceId, { dashboardId, blockId: block.id, vars: selected }, signal),
  });
}
