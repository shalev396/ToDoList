/**
 * What one sync run reads and writes besides its provider (types only): its cursors, its rows and
 * a fresh read of its integration. The engine (SyncEngine) runs on either store:
 * - the database: the integration's own SyncCursors and SyncedRows, each write as it happens;
 * - a fixture replay of an integration that never synced, kept in memory (FreshReplay) and
 *   written with the other runs of its batch at once (SyncEngine.executeTogether).
 */
import type { ContainerData } from '../../models/definitions/Container.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { SourceRef } from '../../models/definitions/common.js';
import type { SyncCursors } from './SyncCursors.js';
import type { SyncedRows } from './SyncedRows.js';

/** What a run's container lookups need of a container: its id and topic, the resource it is from. */
export type ContainerRow = Pick<ContainerData, 'id' | 'topicId' | 'syncResource'> & {
  source: Pick<SourceRef, 'externalId'>;
};

/** Where a run's container lookups read from (ContainerCache). */
export interface ContainerSource {
  /** Its live containers, all or only these external ids. */
  containers(externalIds?: readonly string[]): Promise<readonly ContainerRow[]>;
}

/** A run's cursors, as SyncCursors keeps them. */
export type RunCursors = Pick<SyncCursors, 'run' | 'get' | 'save' | 'saveRun' | 'countFailedRun'>;

/** A run's rows, as SyncedRows writes them. */
export type RunRows = ContainerSource &
  Pick<
    SyncedRows,
    | 'upsertContainers'
    | 'upsertItems'
    | 'deleteContainers'
    | 'deleteItems'
    | 'sweepItems'
    | 'sweepContainers'
    | 'sweepOrphanedItems'
    | 'sweepOrphanedContainers'
    | 'softDeleteAll'
  >;

export interface RunStore {
  readonly cursors: RunCursors;
  readonly rows: RunRows;
  /** The integration as stored now (null: disconnected or gone). */
  reload(): Promise<IntegrationData | null>;
}
