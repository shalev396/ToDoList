/**
 * Data migrations: the stored documents brought to what the code reads. Indexes and validators
 * are sync-db's (config/providers/mongoose.ts); these change data, in order, each once.
 *
 * - `sync-db` runs them after the indexes and validators (deploy:backend, the sync-db action).
 * - Each is recorded in `Migrations` ({_id: id, appliedAt, counts}) and is idempotent, so two
 *   servers starting together, or a run that stopped part-way, are harmless.
 */
import { addImportanceAttribute } from './addImportanceAttribute.js';
import { blockConnectors } from './blockConnectors.js';
import { calendarLinkDeleteAnswered } from './calendarLinkDeleteAnswered.js';
import { dropAreaScope } from './dropAreaScope.js';
import { integrationOwners } from './integrationOwners.js';
import { introduceTopics } from './introduceTopics.js';
import { orphanedDashboards } from './orphanedDashboards.js';
import { orphanedIntegrations } from './orphanedIntegrations.js';
import { orphanedTopics } from './orphanedTopics.js';
import { primaryCalendar } from './primaryCalendar.js';
import { primaryCalendarRead } from './primaryCalendarRead.js';
import { removeGoogleDrive } from './removeGoogleDrive.js';
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

/**
 * Runs the pending migrations in order and records each. One line per migration: names and counts
 * only, never a value.
 */
export async function runMigrations(db: Db, now: Date = new Date()): Promise<string[]> {
  const pending = new Set(await pendingMigrationIds(db));
  const records = db.collection<MigrationRecord>(MIGRATIONS_COLLECTION);
  const lines: string[] = [];
  for (const migration of MIGRATIONS) {
    if (!pending.has(migration.id)) {
      lines.push(`${migration.id}: already applied`);
      continue;
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
  return lines;
}
