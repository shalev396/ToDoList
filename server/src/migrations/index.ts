/**
 * Data migrations: the stored documents brought to what the code reads. Indexes and validators
 * are sync-db's (config/providers/mongoose.ts); these change data, in order, each once.
 *
 * - `sync-db` runs them after the indexes and validators (deploy:backend, the sync-db action).
 * - Each is recorded in `Migrations` ({_id: id, appliedAt, counts}) and is idempotent, so two
 *   servers starting together, or a run that stopped part-way (out of time: sync-db then answers
 *   `done: false` and the deploy script asks again), are harmless.
 */
import { addImportanceAttribute } from './addImportanceAttribute.js';
import { blockConnectors } from './blockConnectors.js';
import { calendarLinkDeleteAnswered } from './calendarLinkDeleteAnswered.js';
import { clockTimedKinds } from './clockTimedKinds.js';
import { dropAreaScope } from './dropAreaScope.js';
import { integrationOwners } from './integrationOwners.js';
import { introduceTopics } from './introduceTopics.js';
import { orphanedDashboards } from './orphanedDashboards.js';
import { orphanedIntegrations } from './orphanedIntegrations.js';
import { orphanedTopics } from './orphanedTopics.js';
import { primaryCalendar } from './primaryCalendar.js';
import { primaryCalendarRead } from './primaryCalendarRead.js';
import { removeGoogleDrive } from './removeGoogleDrive.js';
import { seriesEnds } from './seriesEnds.js';
import { topicColours } from './topicColours.js';
import type { TimeBudget } from '../classes/integration/calendar/TimeBudget.js';
import type { Db, Migration } from './types.js';

export type { Db, Migration } from './types.js';

export const MIGRATIONS_COLLECTION = 'Migrations';

/** In the order they run. */
export const MIGRATIONS: readonly Migration[] = [
  dropAreaScope,
  introduceTopics,
  addImportanceAttribute,
  integrationOwners,
  orphanedIntegrations,
  blockConnectors,
  removeGoogleDrive,
  primaryCalendar,
  primaryCalendarRead,
  calendarLinkDeleteAnswered,
  orphanedDashboards,
  orphanedTopics,
  topicColours,
  seriesEnds,
  clockTimedKinds,
];

interface MigrationRecord {
  _id: string;
  appliedAt: Date;
  counts: Record<string, number>;
}

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** The ids of the migrations not applied yet, in order. */
export async function pendingMigrationIds(db: Db): Promise<string[]> {
  const applied = await db
    .collection<MigrationRecord>(MIGRATIONS_COLLECTION)
    .find({}, { projection: { _id: 1 } })
    .toArray();
  const done = new Set(applied.map((record) => record._id));
  return MIGRATIONS.filter((migration) => !done.has(migration.id)).map(({ id }) => id);
}

function describeCounts(counts: Record<string, number>): string {
  const parts = Object.entries(counts).map(([name, count]) => `${name}=${String(count)}`);
  return parts.length === 0 ? '' : ` (${parts.join(', ')})`;
}

export interface MigrationRun {
  /** One line per migration reached. */
  lines: string[];
  /** The ids not applied yet because the time ran out first, in order; empty for a full run. */
  pending: string[];
}

export interface MigrationOptions {
  /**
   * An empty `Migrations` record means a fresh database: every migration is recorded as applied
   * and none runs. True on qa only (stageMaintenance.syncSchema): every PR check that tests against
   * qa resets it first (reset-db drops the database, records included), and what it holds
   * afterwards was written by the code being released, so there is nothing to migrate. Replaying
   * every migration over the e2e data would not fit one invoke.
   */
  freshIfUnrecorded?: boolean;
}

/** Records every migration as applied without running it; one line each. */
async function recordAllUnrun(db: Db, now: Date): Promise<string[]> {
  const records = db.collection<MigrationRecord>(MIGRATIONS_COLLECTION);
  try {
    await records.insertMany(
      MIGRATIONS.map(({ id }) => ({ _id: id, appliedAt: now, counts: {} })),
      { ordered: false },
    );
  } catch (error) {
    // Another server recorded some meanwhile: the rest went in (unordered).
    if (!isDuplicateKey(error)) throw error;
  }
  return MIGRATIONS.map(({ id }) => `${id}: recorded without running (fresh database)`);
}

/**
 * Runs the pending migrations in order and records each. One line per migration: names and counts
 * only, never a value. With a `budget`, a migration starts only while `reserveMs` is still left:
 * the run then stops cleanly, before the next one, and answers the ids it did not reach.
 */
export async function runMigrationsWithin(
  db: Db,
  now: Date,
  budget: TimeBudget | null,
  reserveMs: number,
  options: MigrationOptions = {},
): Promise<MigrationRun> {
  const records = db.collection<MigrationRecord>(MIGRATIONS_COLLECTION);
  if (
    options.freshIfUnrecorded === true &&
    (await records.countDocuments({}, { limit: 1 })) === 0
  ) {
    return { lines: await recordAllUnrun(db, now), pending: [] };
  }
  const pending = new Set(await pendingMigrationIds(db));
  const lines: string[] = [];
  for (const [index, migration] of MIGRATIONS.entries()) {
    if (!pending.has(migration.id)) {
      lines.push(`${migration.id}: already applied`);
      continue;
    }
    if (budget !== null && !budget.canStart(reserveMs)) {
      const stopped = MIGRATIONS.slice(index)
        .filter(({ id }) => pending.has(id))
        .map(({ id }) => id);
      return { lines, pending: stopped };
    }
    const counts = await migration.run(db, now);
    try {
      await records.insertOne({ _id: migration.id, appliedAt: now, counts });
    } catch (error) {
      // Another server recorded it meanwhile: the migration is idempotent, so both runs agree.
      if (!isDuplicateKey(error)) throw error;
    }
    lines.push(`${migration.id}: applied${describeCounts(counts)}`);
  }
  return { lines, pending: [] };
}

/** Every pending migration, with no deadline (a test's, a local run). */
export async function runMigrations(db: Db, now: Date = new Date()): Promise<string[]> {
  return (await runMigrationsWithin(db, now, null, 0)).lines;
}
