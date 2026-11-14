import type mongoose from 'mongoose';

/** The raw driver database: migrations read and write documents as stored, not through models. */
export type Db = mongoose.mongo.Db;

/**
 * One data migration. It must be idempotent: a run interrupted part-way, or two servers starting
 * at once, may run it again. `run` answers counts (names and numbers only, never a value).
 */
export interface Migration {
  /** Stable, sortable: `<date>-<what>`. Recorded once applied. */
  id: string;
  run(db: Db, now: Date): Promise<Record<string, number>>;
}
