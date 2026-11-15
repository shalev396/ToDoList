/**
 * One run's view of its integration's live containers, by external id (what an item needs of its
 * container: its id, its topic, and the resource that swept it). Loaded at the first lookup of
 * the run, then kept current after the run writes or sweeps containers.
 */
import type { ContainerData } from '../../models/definitions/Container.js';
import type { SyncedRows } from './SyncedRows.js';

/** What items need of their container: its id and topic (and the resource that swept it). */
export type CachedContainer = Pick<ContainerData, 'id' | 'topicId' | 'syncResource'>;

export class ContainerCache {
  readonly #rows: SyncedRows;
  /** null until the first lookup. */
  #byExternalId: Map<string, CachedContainer> | null = null;

  constructor(rows: SyncedRows) {
    this.#rows = rows;
  }

  /** An item's container, by its external id (every container is read at the first lookup). */
  async find(externalId: string | null | undefined): Promise<CachedContainer | null> {
    if (externalId === undefined || externalId === null || externalId === '') return null;
    this.#byExternalId ??= await this.#load();
    return this.#byExternalId.get(externalId) ?? null;
  }

  /**
   * After containers were written or swept: looks up only those external ids again, so the cache
   * gains new ones, follows changes (a topic) and drops deleted ones. Nothing to do before the
   * cache is loaded: the first lookup reads every container.
   */
  async refresh(externalIds: readonly string[]): Promise<void> {
    const cache = this.#byExternalId;
    if (cache === null || externalIds.length === 0) return;
    const fresh = await this.#load(externalIds);
    for (const externalId of externalIds) {
      const container = fresh.get(externalId);
      if (container === undefined) cache.delete(externalId);
      else cache.set(externalId, container);
    }
  }

  /** After `resource` was swept: its containers looked up again (none when not loaded yet). */
  async refreshResource(resource: string): Promise<void> {
    if (this.#byExternalId === null) return;
    const ofResource = [...this.#byExternalId]
      .filter(([, container]) => container.syncResource === resource)
      .map(([externalId]) => externalId);
    await this.refresh(ofResource);
  }

  /** Its live containers, all of them or only the given external ids. */
  async #load(externalIds?: readonly string[]): Promise<Map<string, CachedContainer>> {
    const list = await this.#rows.containers(externalIds);
    return new Map(
      list.map(({ id, topicId, syncResource, source }) => [
        source.externalId,
        { id, topicId, syncResource },
      ]),
    );
  }
}
