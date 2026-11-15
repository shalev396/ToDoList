/**
 * One run's accounting: its counts, the records it skipped (the first MAX_RECORDED_FAILURES kept
 * on the run, every failed id kept out of the sweeps), and the records that failed without an id
 * (the resource they came from can't be swept then). A skipped record is recorded and the run
 * goes on; an invalid field is logged by name (never its value), once per run.
 */
import type { SourceDeleteResult, SourceRef } from '../../models/definitions/common.js';
import type { ItemBulkUpsertResult } from '../../models/definitions/Item.js';
import type { SyncRunFailure } from '../../models/definitions/SyncRun.js';
import { logger } from '../../services/logger.js';
import { deletedRecordProblem } from '../../sync/recordCheck.js';
import type { DeletedRecord, SyncCounts } from '../../sync/types.js';
import { sourceProblem, zeroCounts } from './syncRecords.js';

/** Skipped records listed on a run; `counts.failed` has the total. */
export const MAX_RECORDED_FAILURES = 50;

export class SyncTally {
  readonly #runId: string;
  readonly #integrationId: string;
  readonly #counts: SyncCounts = zeroCounts();
  readonly #failures: SyncRunFailure[] = [];
  /** Every external id that failed in this run: never swept (a failure is not a deletion). */
  readonly #failedIds = new Set<string>();
  /** Failed records without an id: the resource they came from cannot be swept this run. */
  #unidentified = 0;
  /** Invalid fields already logged in this run, as `<resource> <field>`: one warning each. */
  readonly #loggedInvalidFields = new Set<string>();

  constructor(runId: string, integrationId: string) {
    this.#runId = runId;
    this.#integrationId = integrationId;
  }

  /** The counts so far (a copy). */
  get counts(): SyncCounts {
    return { ...this.#counts };
  }

  /** The skipped records kept on the run (the first MAX_RECORDED_FAILURES). */
  get failures(): SyncRunFailure[] {
    return this.#failures.map((failure) => ({ ...failure }));
  }

  /** Whether any record was skipped (a `partial` run). */
  get anyFailed(): boolean {
    return this.#counts.failed > 0;
  }

  /** Records that failed without an id so far. */
  get unidentified(): number {
    return this.#unidentified;
  }

  /** The external ids no sweep may delete: every record that failed in this run so far. */
  keptExternalIds(): string[] {
    return [...this.#failedIds];
  }

  /** Records the adapter yielded (delete-only ones and reported failures included). */
  fetched(count: number): void {
    this.#counts.fetched += count;
  }

  /** An upsert of live items: inserted, updated, unchanged, closed. */
  upserted(result: ItemBulkUpsertResult): void {
    this.#counts.inserted += result.inserted;
    this.#counts.updated += result.updated;
    this.#counts.unchanged += result.unchanged;
    this.#counts.closed += result.closed;
  }

  /** An upsert of items that carry their delete: written ones count as deleted. */
  signalled(result: ItemBulkUpsertResult): void {
    this.#counts.deleted += result.inserted + result.updated;
    this.#counts.unchanged += result.unchanged;
  }

  /** Delete-only items: deleted, or unchanged when already deleted. */
  sourceDeleted(result: SourceDeleteResult): void {
    this.#counts.deleted += result.deleted;
    this.#counts.unchanged += result.alreadyDeleted;
  }

  /** Items a sweep deleted. */
  swept(count: number): void {
    this.#counts.deleted += count;
  }

  /** Counts a skipped record, keeps its id out of the sweeps, and records the first 50. */
  recordFailure(externalId: unknown, code: string): void {
    const id = typeof externalId === 'string' ? externalId : '';
    this.#counts.failed += 1;
    if (id === '') this.#unidentified += 1;
    else this.#failedIds.add(id);
    if (this.#failures.length < MAX_RECORDED_FAILURES) {
      this.#failures.push({ externalId: id, code });
    }
  }

  /**
   * Why a mapped record is skipped, as its failure code, or null when it can be stored: no id or
   * link (`missing_id`, `missing_url`), or a field that fails validation (`invalid_record`,
   * recordCheck.ts).
   */
  skipCode(resource: string, source: SourceRef, invalidField: () => string | null): string | null {
    const missing = sourceProblem(source);
    if (missing !== null) return missing;
    const field = invalidField();
    return field === null ? null : this.#invalidRecord(resource, field);
  }

  /** The ids of the valid delete-only records; the others are recorded as failures. */
  deletedIds(resource: string, records: readonly DeletedRecord[]): string[] {
    const ids: string[] = [];
    for (const record of records) {
      const { externalId } = record;
      if (typeof externalId !== 'string' || externalId === '') {
        this.recordFailure(externalId, 'missing_id');
        continue;
      }
      const field = deletedRecordProblem(record);
      if (field === null) ids.push(externalId);
      else this.recordFailure(externalId, this.#invalidRecord(resource, field));
    }
    return ids;
  }

  /** A record failed validation: its field is logged by name (never its value), once per run. */
  #invalidRecord(resource: string, field: string): 'invalid_record' {
    const logged = `${resource} ${field}`;
    if (!this.#loggedInvalidFields.has(logged)) {
      this.#loggedInvalidFields.add(logged);
      logger.warn('sync record skipped: invalid field', {
        runId: this.#runId,
        integrationId: this.#integrationId,
        resource,
        field,
      });
    }
    return 'invalid_record';
  }
}
