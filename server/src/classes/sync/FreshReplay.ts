/**
 * One run of a batch of fixture replays (SyncEngine.executeTogether), kept in memory until the
 * batch writes every run's rows and cursors at once. A store of the engine (SyncStore.ts): the
 * engine runs on it exactly as on the database, so the same records, counts and cursors come out.
 *
 * Only for an integration that has never synced: no item or container of it is stored (the batch
 * checks first). Then every write the engine makes is answered without the database:
 * - an upsert inserts (nothing is stored to compare with): every record is `inserted`, none
 *   `updated`, `unchanged` or `closed`. A new container takes its id here, so the items after it
 *   name it, and the batch writes it with that id;
 * - a sweep deletes nothing: every row the run has is one it wrote (seen now) of a resource it
 *   lists;
 * - its container lookups read the containers it wrote so far, as the database would answer them;
 * - its cursors start from the states stored when the batch began (the batch reads them at once).
 * What the database would answer differently is refused (NotReplayableError), before anything is
 * written: a record written twice in one run, a delete-only record. The batch then runs that
 * integration's sync on the database instead.
 */
import { randomUUID } from 'node:crypto';

import type {
  BulkUpsertResult,
  SourceDeleteResult,
  SourceRef,
} from '../../models/definitions/common.js';
import type { ContainerUpsert } from '../../models/definitions/Container.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { ItemBulkUpsertResult, ItemUpsert } from '../../models/definitions/Item.js';
import type {
  SyncStateData,
  SyncStatePatch,
  SyncStateUpsert,
} from '../../models/definitions/SyncState.js';
import { SyncCursor } from './SyncCursor.js';
import { SyncCursors } from './SyncCursors.js';
import type { ContainerRow, RunCursors, RunRows, RunStore } from './SyncStore.js';

/** A write the database would answer otherwise than a replay can: the run syncs on it instead. */
export class NotReplayableError extends Error {
  constructor(reason: string) {
    super(`FreshReplay: ${reason}`);
    this.name = 'NotReplayableError';
  }
}

/** A record's natural key within one integration (its provider account and external id). */
function keyOf(source: SourceRef): string {
  return JSON.stringify([source.provider, source.accountId, source.externalId]);
}

export class FreshReplay implements RunStore, RunCursors, RunRows {
  readonly #integration: IntegrationData;
  /** The states stored when the batch began, by resource, then as the run saved them. */
  readonly #states: Map<string, SyncStateData>;
  readonly #containers: ContainerUpsert[] = [];
  readonly #items: ItemUpsert[] = [];
  readonly #saves: SyncStateUpsert[] = [];
  readonly #containerKeys = new Set<string>();
  readonly #itemKeys = new Set<string>();

  /** A replay of `integration`, its cursors starting from `states` (its stored ones). */
  constructor(integration: IntegrationData, states: readonly SyncStateData[]) {
    this.#integration = integration;
    this.#states = new Map(states.map((state) => [state.resource, state]));
  }

  get cursors(): RunCursors {
    return this;
  }

  get rows(): RunRows {
    return this;
  }

  /** The integration as the batch began (the batch reads it again before it writes). */
  reload(): Promise<IntegrationData | null> {
    return Promise.resolve(this.#integration);
  }

  /** The containers the run wrote, in order, each with its new id. */
  get writtenContainers(): readonly ContainerUpsert[] {
    return this.#containers;
  }

  /** The items the run wrote, in order. */
  get writtenItems(): readonly ItemUpsert[] {
    return this.#items;
  }

  /** The cursors the run saved, in order. */
  get savedCursors(): readonly SyncStateUpsert[] {
    return this.#saves;
  }

  // ─── Cursors ───────────────────────────────────────────────────────────────

  run(): Promise<SyncCursor> {
    return this.get(SyncCursors.RUN);
  }

  get(resource: string): Promise<SyncCursor> {
    return Promise.resolve(SyncCursor.of(this.#states.get(resource) ?? null));
  }

  save(resource: string, patch: SyncStatePatch): Promise<SyncCursor> {
    const { id: integrationId, workspaceId } = this.#integration;
    this.#saves.push({ integrationId, resource, patch });
    const base = this.#states.get(resource);
    const now = new Date();
    const state: SyncStateData = {
      id: base?.id ?? '',
      workspaceId,
      integrationId,
      resource,
      cursor: patch.cursor === undefined ? (base?.cursor ?? null) : patch.cursor,
      syncToken: patch.syncToken === undefined ? (base?.syncToken ?? null) : patch.syncToken,
      etag: patch.etag === undefined ? (base?.etag ?? null) : patch.etag,
      updatedSince:
        patch.updatedSince === undefined ? (base?.updatedSince ?? null) : patch.updatedSince,
      lastFullSyncAt:
        patch.lastFullSyncAt === undefined ? (base?.lastFullSyncAt ?? null) : patch.lastFullSyncAt,
      lastIncrementalAt:
        patch.lastIncrementalAt === undefined
          ? (base?.lastIncrementalAt ?? null)
          : patch.lastIncrementalAt,
      backoffUntil:
        patch.backoffUntil === undefined ? (base?.backoffUntil ?? null) : patch.backoffUntil,
      consecutiveErrors: patch.consecutiveErrors ?? base?.consecutiveErrors ?? 0,
      createdAt: base?.createdAt ?? now,
      updatedAt: now,
    };
    this.#states.set(resource, state);
    return Promise.resolve(SyncCursor.of(state));
  }

  saveRun(patch: SyncStatePatch): Promise<SyncCursor> {
    return this.save(SyncCursors.RUN, patch);
  }

  /** A failed run is counted in the database: the batch finishes it there. */
  countFailedRun(): Promise<number> {
    return FreshReplay.#refuse('a failed run is counted in the database');
  }

  // ─── Rows ──────────────────────────────────────────────────────────────────

  containers(externalIds?: readonly string[]): Promise<readonly ContainerRow[]> {
    const wanted = externalIds === undefined ? null : new Set(externalIds);
    return Promise.resolve(
      this.#containers
        .filter((container) => (container.deletedAt ?? null) === null)
        .filter((container) => wanted === null || wanted.has(container.source.externalId))
        .map((container) => ({
          id: container.id ?? '',
          topicId: container.topicId,
          syncResource: container.syncResource ?? null,
          source: container.source,
        })),
    );
  }

  upsertContainers(rows: readonly ContainerUpsert[]): Promise<BulkUpsertResult> {
    for (const row of rows) {
      FreshReplay.#claim(this.#containerKeys, row.source, 'a container written twice');
      this.#containers.push({ ...row, id: randomUUID() });
    }
    return Promise.resolve({ inserted: rows.length, updated: 0, unchanged: 0 });
  }

  upsertItems(rows: readonly ItemUpsert[]): Promise<ItemBulkUpsertResult> {
    for (const row of rows) {
      FreshReplay.#claim(this.#itemKeys, row.source, 'an item written twice');
      this.#items.push({ ...row });
    }
    return Promise.resolve({ inserted: rows.length, updated: 0, unchanged: 0, closed: 0 });
  }

  deleteContainers(): Promise<SourceDeleteResult> {
    return FreshReplay.#refuse('a delete-only container');
  }

  deleteItems(): Promise<SourceDeleteResult> {
    return FreshReplay.#refuse('a delete-only item');
  }

  /** None: every row the run has is one it wrote now, of a resource it lists. */
  sweepItems(): Promise<number> {
    return Promise.resolve(0);
  }

  /** None, as sweepItems. */
  sweepContainers(): Promise<number> {
    return Promise.resolve(0);
  }

  /** None, as sweepItems. */
  sweepOrphanedItems(): Promise<number> {
    return Promise.resolve(0);
  }

  /** None, as sweepItems. */
  sweepOrphanedContainers(): Promise<number> {
    return Promise.resolve(0);
  }

  /** A disconnect is finished in the database. */
  softDeleteAll(): Promise<void> {
    return FreshReplay.#refuse('a disconnect is finished in the database');
  }

  static #refuse(reason: string): Promise<never> {
    return Promise.reject(new NotReplayableError(reason));
  }

  /** A natural key the run has not written yet; a second write is not an insert. */
  static #claim(keys: Set<string>, source: SourceRef, reason: string): void {
    const key = keyOf(source);
    if (keys.has(key)) throw new NotReplayableError(reason);
    keys.add(key);
  }
}
