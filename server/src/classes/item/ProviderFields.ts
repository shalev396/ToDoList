/**
 * Provider fields (H4) for one caller: the custom fields their visible items' providers synced into
 * `props` (services/providerFields.ts discovers them from the data, purely), read from a recent
 * sample of what the caller may see (ItemPolicy: their own integrations', the shared ones' and
 * their visible to-dos'; never an unshared integration's) and cached for a minute, keyed by that
 * access too, so Stop sharing (or a new attach) changes the answer from the next request on.
 */
import type { WorkspaceContext } from '../base/Caller.js';
import { ItemPolicy, type ItemAccess } from '../policies/ItemPolicy.js';
import { getItemRepository } from '../../models/index.js';
import { discoverFields } from '../../services/providerFields.js';
import type { ProviderField } from '../../types/builder.js';

const SAMPLE_ITEMS = 400;
const CACHE_MS = 60_000;
const CACHE_MAX = 500;

function isPlain(value: unknown): value is Record<string, unknown> {
  return (
    typeof value === 'object' && value !== null && !Array.isArray(value) && !(value instanceof Date)
  );
}

/** What the access lets the caller see, as a cache key: the integrations and the to-dos. */
function accessKey(access: ItemAccess): string {
  return [access.local, ...access.integrations.map(({ id }) => id).sort()].join(',');
}

export class ProviderFields {
  static readonly #cache = new Map<string, { at: number; fields: ProviderField[] }>();

  readonly #ws: Pick<WorkspaceContext, 'id' | 'onlyTopics'>;
  readonly #userId: string;

  private constructor(ws: Pick<WorkspaceContext, 'id' | 'onlyTopics'>, userId: string) {
    this.#ws = ws;
    this.#userId = userId;
  }

  /** The provider fields of what `userId` may see in this workspace. */
  static for(ws: Pick<WorkspaceContext, 'id' | 'onlyTopics'>, userId: string): ProviderFields {
    return new ProviderFields(ws, userId);
  }

  /** The provider fields the items `userId` may see in this workspace carry (`for(…).list`). */
  static of(
    ws: Pick<WorkspaceContext, 'id' | 'onlyTopics'>,
    userId: string,
    now: number = Date.now(),
  ): Promise<ProviderField[]> {
    return ProviderFields.for(ws, userId).list(now);
  }

  /** The fields, from the cache when it is under a minute old for this access. */
  async list(now: number = Date.now()): Promise<ProviderField[]> {
    const ws = this.#ws;
    const policy = await ItemPolicy.for({ workspaceId: ws.id, userId: this.#userId });
    const key = `${ws.id}:${this.#userId}:${accessKey(policy.access)}`;
    const cache = ProviderFields.#cache;
    const hit = cache.get(key);
    if (hit !== undefined && now - hit.at < CACHE_MS) return hit.fields;
    const rows = await (
      await getItemRepository()
    ).aggregate(
      ws.id,
      [
        { $match: policy.itemFilter(ws) },
        { $sort: { updatedAt: -1 } },
        { $limit: SAMPLE_ITEMS },
        { $project: { provider: '$source.provider', props: 1 } },
      ],
      { maxTimeMS: 5000 },
    );
    const fields = discoverFields(
      rows.map((row) => ({
        provider: typeof row['provider'] === 'string' ? row['provider'] : 'local',
        props: isPlain(row['props']) ? row['props'] : {},
      })),
    );
    if (cache.size >= CACHE_MAX) cache.clear();
    cache.set(key, { at: now, fields });
    return fields;
  }
}
