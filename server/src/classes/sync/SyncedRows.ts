/**
 * What one integration's syncs wrote: its mirrored items and containers, as the sync engine
 * writes them (bulk upserts on the natural key, deletes by external id, the sweeps) and as a
 * disconnect or the purge removes them. Internal to the sync: not in any barrel, and an importer
 * test (syncInternals.test.ts) holds that only the engine, its container cache, Integration (its
 * disconnect and a gone integration's run) and the purge load it. So these writes, which take raw
 * ids, are never reachable from a route, a controller or an MCP tool.
 *
 * The one global write, `purgeDeletedBefore` (every workspace), is the purge's alone: no other
 * module may even name it.
 */
import type {
  BulkUpsertOptions,
  BulkUpsertResult,
  SourceAccount,
  SourceDeleteResult,
  SweepOptions,
} from '../../models/definitions/common.js';
import type { ContainerData, ContainerUpsert } from '../../models/definitions/Container.js';
import type {
  ItemBulkUpsertResult,
  ItemSweepOptions,
  ItemUpsert,
} from '../../models/definitions/Item.js';
import { getContainerRepository, getItemRepository } from '../../models/index.js';
import { TravelData } from '../travel/TravelData.js';
import type { SyncRunOwner } from './SyncRun.js';

export class SyncedRows {
  readonly #workspaceId: string;
  readonly #integrationId: string;

  private constructor(owner: SyncRunOwner) {
    this.#workspaceId = owner.workspaceId;
    this.#integrationId = owner.id;
    Object.freeze(this);
  }

  /** The rows of one integration of a workspace (resolved in its workspace by the caller). */
  static of(owner: SyncRunOwner): SyncedRows {
    return new SyncedRows(owner);
  }

  /**
   * GLOBAL, every workspace (the purge only): items and containers soft-deleted before `before`,
   * hard-deleted. How many of each.
   */
  static async purgeDeletedBefore(before: Date): Promise<{ items: number; containers: number }> {
    const items = await (await getItemRepository()).purgeDeletedBefore(before);
    const containers = await (await getContainerRepository()).purgeDeletedBefore(before);
    return { items, containers };
  }

  /** Whether any item or container (deleted ones too) belongs to one of these integrations. */
  static async anyOf(workspaceId: string, integrationIds: readonly string[]): Promise<boolean> {
    const [items, containers] = await Promise.all([getItemRepository(), getContainerRepository()]);
    const found = await Promise.all([
      items.existsForIntegrations(workspaceId, integrationIds),
      containers.existsForIntegrations(workspaceId, integrationIds),
    ]);
    return found.includes(true);
  }

  /**
   * The rows of several integrations of a workspace (each resolved there by the caller), bulk-
   * upserted on their natural keys: the containers and the items at once (an item names its
   * container's id, which a new container takes from its record: SyncEngine.executeTogether).
   * `assumeNew`: the caller checked that none is stored (BulkUpsertOptions).
   */
  static async upsertAll(
    workspaceId: string,
    containers: readonly ContainerUpsert[],
    items: readonly ItemUpsert[],
    options: BulkUpsertOptions = {},
  ): Promise<{ containers: BulkUpsertResult; items: ItemBulkUpsertResult }> {
    const [itemRepository, containerRepository] = await Promise.all([
      getItemRepository(),
      getContainerRepository(),
    ]);
    const [containersDone, itemsDone] = await Promise.all([
      containerRepository.bulkUpsert(workspaceId, containers, options),
      itemRepository.bulkUpsert(workspaceId, items, options),
    ]);
    return { containers: containersDone, items: itemsDone };
  }

  /** Its live containers, all or only these external ids. */
  async containers(externalIds?: readonly string[]): Promise<ContainerData[]> {
    return (await getContainerRepository()).list(this.#workspaceId, {
      integrationId: this.#integrationId,
      ...(externalIds === undefined ? {} : { externalIds }),
    });
  }

  /** One page of mapped containers, bulk-upserted on their natural key. */
  async upsertContainers(rows: readonly ContainerUpsert[]): Promise<BulkUpsertResult> {
    return (await getContainerRepository()).bulkUpsert(this.#workspaceId, rows);
  }

  /** One page of mapped items, bulk-upserted on their natural key. */
  async upsertItems(rows: readonly ItemUpsert[]): Promise<ItemBulkUpsertResult> {
    return (await getItemRepository()).bulkUpsert(this.#workspaceId, rows);
  }

  /** Containers its provider says are deleted, by external id (in `account`), at `at`. */
  async deleteContainers(
    account: SourceAccount,
    externalIds: readonly string[],
    at: Date,
  ): Promise<SourceDeleteResult> {
    return (await getContainerRepository()).softDeleteBySource(
      this.#workspaceId,
      account,
      externalIds,
      at,
    );
  }

  /** Items its provider says are deleted, by external id (in `account`), at `at`. */
  async deleteItems(
    account: SourceAccount,
    externalIds: readonly string[],
    at: Date,
  ): Promise<SourceDeleteResult> {
    return (await getItemRepository()).softDeleteBySource(
      this.#workspaceId,
      account,
      externalIds,
      at,
    );
  }

  /** A full listing's sweep of its items: `resource`'s not seen since `before` (in its window). */
  async sweepItems(resource: string, before: Date, options: ItemSweepOptions): Promise<number> {
    return (await getItemRepository()).sweepUnseen(
      this.#workspaceId,
      this.#integrationId,
      resource,
      before,
      options,
    );
  }

  /** A full listing's sweep of its containers: `resource`'s not seen since `before`. */
  async sweepContainers(resource: string, before: Date, options: SweepOptions): Promise<number> {
    return (await getContainerRepository()).sweepUnseen(
      this.#workspaceId,
      this.#integrationId,
      resource,
      before,
      options,
    );
  }

  /** Its items of resources it no longer lists, soft-deleted. How many. */
  async sweepOrphanedItems(resources: readonly string[], options: SweepOptions): Promise<number> {
    return (await getItemRepository()).sweepOrphanedResources(
      this.#workspaceId,
      this.#integrationId,
      resources,
      options,
    );
  }

  /** Its containers of resources it no longer lists, soft-deleted. How many. */
  async sweepOrphanedContainers(
    resources: readonly string[],
    options: SweepOptions,
  ): Promise<number> {
    return (await getContainerRepository()).sweepOrphanedResources(
      this.#workspaceId,
      this.#integrationId,
      resources,
      options,
    );
  }

  /**
   * Every item, then every container, soft-deleted (at `at`, or now): a disconnect, or what a run
   * wrote or revived after one.
   */
  async softDeleteAll(at?: Date): Promise<void> {
    await (
      await getItemRepository()
    ).softDeleteForIntegration(this.#workspaceId, this.#integrationId, at);
    const containers = await getContainerRepository();
    // Travel rules for "every repeat" of an event name its calendar and hold its title.
    await TravelData.forgetContainers(
      this.#workspaceId,
      await containers.idsForIntegration(this.#workspaceId, this.#integrationId),
    );
    await containers.softDeleteForIntegration(this.#workspaceId, this.#integrationId, at);
  }
}
