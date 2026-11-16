/**
 * One integration's sync cursors (SyncStates, DATA.md §3.8), one per resource it syncs, plus the
 * `__run__` pseudo-resource the engine keeps for the integration as a whole (failed runs in a row,
 * the last complete full sync). The only code that reads or writes SyncStates.
 *
 * The unique index (integrationId, resource) has no `workspaceId`: the integration is resolved in
 * its workspace before its cursors are opened (every caller holds the integration).
 */
import type {
  SyncStateData,
  SyncStatePatch,
  SyncStateUpsert,
} from '../../models/definitions/SyncState.js';
import { getSyncStateRepository } from '../../models/index.js';
import { SyncCursor } from './SyncCursor.js';

export class SyncCursors {
  /** The pseudo-resource for the integration as a whole: failed runs in a row, last full sync. */
  static readonly RUN = '__run__';

  readonly #workspaceId: string;
  readonly #integrationId: string;

  private constructor(workspaceId: string, integrationId: string) {
    this.#workspaceId = workspaceId;
    this.#integrationId = integrationId;
    Object.freeze(this);
  }

  /** The cursors of one integration of a workspace. */
  static of(integration: { readonly id: string; readonly workspaceId: string }): SyncCursors {
    return new SyncCursors(integration.workspaceId, integration.id);
  }

  /**
   * Every stored state of these integrations of a workspace (each resolved there by the caller),
   * by integration: what a batch of runs reads in one round trip (SyncEngine.executeTogether).
   */
  static async listOf(
    workspaceId: string,
    integrationIds: readonly string[],
  ): Promise<Map<string, SyncStateData[]>> {
    const states = await (
      await getSyncStateRepository()
    ).listForIntegrations(workspaceId, integrationIds);
    const byIntegration = new Map<string, SyncStateData[]>(integrationIds.map((id) => [id, []]));
    for (const state of states) byIntegration.get(state.integrationId)?.push(state);
    return byIntegration;
  }

  /**
   * `save` for each entry, in one write, in order: what a batch of runs stores at its end (each
   * integration resolved in the workspace by the caller).
   */
  static async saveAll(workspaceId: string, saves: readonly SyncStateUpsert[]): Promise<void> {
    await (await getSyncStateRepository()).upsertMany(workspaceId, saves);
  }

  /** Where `resource` stands (none when it was never synced). */
  async get(resource: string): Promise<SyncCursor> {
    return SyncCursor.of(
      await (await getSyncStateRepository()).get(this.#workspaceId, this.#integrationId, resource),
    );
  }

  /** Stores `resource`'s next position: only the fields given change (created on first use). */
  async save(resource: string, patch: SyncStatePatch): Promise<SyncCursor> {
    return SyncCursor.of(
      await (
        await getSyncStateRepository()
      ).upsert(this.#workspaceId, this.#integrationId, resource, patch),
    );
  }

  /** The integration as a whole: failed runs in a row, the last complete full sync. */
  run(): Promise<SyncCursor> {
    return this.get(SyncCursors.RUN);
  }

  /** Stores the integration-wide state (`__run__`). */
  saveRun(patch: SyncStatePatch): Promise<SyncCursor> {
    return this.save(SyncCursors.RUN, patch);
  }

  /** Reconnected (a credential saved again): failed runs in a row start again from 0. */
  async resetFailures(): Promise<void> {
    await this.saveRun({ consecutiveErrors: 0 });
  }

  /**
   * Counts one failed run toward the failed runs in a row, at most once per run (one atomic write
   * counts it and remembers its id, so a retry of its job never counts it twice). The new count,
   * or, when it was already counted, the count as it stands.
   */
  async countFailedRun(runId: string): Promise<number> {
    const states = await getSyncStateRepository();
    return (
      (await states.countFailedRun(
        this.#workspaceId,
        this.#integrationId,
        SyncCursors.RUN,
        runId,
      )) ?? (await this.run()).consecutiveErrors
    );
  }
}
