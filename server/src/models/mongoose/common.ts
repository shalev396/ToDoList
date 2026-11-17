import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

import { PROVIDERS, type Provider } from '../../types/domain.js';
import { stableStringify } from '../../utils/stableStringify.js';
import type {
  BulkUpsertOptions,
  BulkUpsertResult,
  ErrorInfo,
  SourceAccount,
  SourceDeleteResult,
  SourceRef,
} from '../definitions/common.js';

/** `_id` of the new collections: a UUID string, exposed as `id` (DATA.md §1). */
export const uuidIdField = {
  type: String,
  default: (): string => randomUUID(),
};

/** `source` on Items and Containers (DATA.md §3.6). No `_id` of its own. */
export const SourceSchema = new mongoose.Schema<SourceRef>(
  {
    provider: { type: String, enum: PROVIDERS, required: true },
    // Required, but '' is valid: local items have no provider account. Mongoose's
    // `required: true` refuses '' for strings, so the default fills a missing value and this
    // validator refuses anything that is not a string (null included).
    accountId: {
      type: String,
      default: '',
      validate: {
        validator: (value: unknown): boolean => typeof value === 'string',
        message: 'source.accountId is required',
      },
    },
    externalId: { type: String, required: true },
    key: { type: String, default: null },
    url: { type: String, required: true },
    updatedAtSource: { type: Date, default: null },
    etag: { type: String, default: null },
    hash: { type: String, default: null },
  },
  { _id: false },
);

/**
 * `$set` entries for the listed keys a patch carries (undefined = leave unchanged). Only listed
 * keys are copied, so stray properties on a patch (say, from a request body) never reach the
 * database. `prefix` targets a nested path, e.g. `overlay.`.
 */
export function setFields<T extends object>(
  patch: T,
  keys: readonly (keyof T & string)[],
  prefix = '',
): Record<string, unknown> {
  const fields: Record<string, unknown> = {};
  for (const key of keys) {
    const value = patch[key];
    if (value !== undefined) fields[`${prefix}${key}`] = value;
  }
  return fields;
}

/** `{code, message}`: Integrations.lastError and SyncRuns.error. */
export const ErrorInfoSchema = new mongoose.Schema<ErrorInfo>(
  {
    code: { type: String, required: true },
    message: { type: String, required: true },
  },
  { _id: false },
);

/** A plain SourceRef, whether read from a document or given by a sync. */
export function toSourceRef(source: SourceRef): SourceRef {
  return {
    provider: source.provider,
    accountId: source.accountId,
    externalId: source.externalId,
    key: source.key ?? null,
    url: source.url,
    updatedAtSource: source.updatedAtSource ?? null,
    etag: source.etag ?? null,
    hash: source.hash ?? null,
  };
}

/** Stages that read another collection or write: a workspace-scoped pipeline refuses them. */
const UNSCOPED_STAGES = new Set(['$lookup', '$graphLookup', '$unionWith', '$out', '$merge']);

function assertScopedStage(stage: Record<string, unknown>): void {
  for (const [operator, spec] of Object.entries(stage)) {
    if (UNSCOPED_STAGES.has(operator)) {
      throw new Error(`aggregate: ${operator} is not allowed in a workspace-scoped pipeline`);
    }
    if (operator === '$facet' && typeof spec === 'object' && spec !== null) {
      for (const pipeline of Object.values(spec as Record<string, unknown>)) {
        if (Array.isArray(pipeline)) {
          for (const inner of pipeline as Record<string, unknown>[]) assertScopedStage(inner);
        }
      }
    }
  }
}

/**
 * The pipeline a repository's aggregate() runs. A leading `$match` of the caller is merged with
 * the scope, `{ $match: { ...callerMatch, workspaceId } }`: MongoDB requires `$text` in the first
 * stage, so a separate scope stage in front would break text search. Otherwise
 * `{ $match: { workspaceId } }` is prepended. A caller `$match` naming another `workspaceId` is
 * refused; the scoped value always wins. Stages that could reach another workspace's documents or
 * write anywhere ($lookup, $graphLookup, $unionWith, $out, $merge, also inside $facet) are refused.
 */
export function scopedPipeline(
  workspaceId: string,
  stages: readonly Record<string, unknown>[],
): mongoose.PipelineStage[] {
  stages.forEach(assertScopedStage);
  const [first, ...rest] = stages;
  const callerMatch = first?.['$match'];
  if (typeof callerMatch === 'object' && callerMatch !== null && !Array.isArray(callerMatch)) {
    const match = callerMatch as Record<string, unknown>;
    if ('workspaceId' in match && match['workspaceId'] !== workspaceId) {
      throw new Error('aggregate: $match may not name a different workspaceId');
    }
    // The stages are plain JSON from the query compiler, checked above; the driver validates them.
    return [
      { $match: { ...match, workspaceId } },
      ...(rest as unknown as mongoose.PipelineStage[]),
    ];
  }
  return [{ $match: { workspaceId } }, ...(stages as unknown as mongoose.PipelineStage[])];
}

/**
 * A mapped provider record: its source, maybe a delete signalled by the provider, and the sync
 * resource it came from (stamped on every write).
 */
export interface SourceRecord {
  /** The id a new copy gets (default: a random one). */
  id?: string;
  /** The integration whose copy this is: part of the natural key (ruling 8). */
  integrationId: string;
  source: SourceRef;
  deletedAt?: Date | null;
  syncResource?: string | null;
}

/** What upsertBySource() reads of a stored document. */
export interface StoredSource {
  _id: string;
  integrationId?: string | null;
  source: SourceRef;
  deletedAt?: Date | null;
}

/** The collection calls upsertBySource() makes, bound to one model by the repository. */
export interface SourceUpsertStore<S extends StoredSource = StoredSource> {
  /** Stored documents matching the filter, with `_id`, `source` and `deletedAt` (at least). */
  findStored(filter: mongoose.FilterQuery<StoredSource>): Promise<S[]>;
  /** Stored documents matching the filter, every field: what a write is compared against. */
  findWritten(filter: mongoose.FilterQuery<StoredSource>): Promise<Record<string, unknown>[]>;
  bulkWrite(writes: mongoose.AnyBulkWriteOperation[]): Promise<{ upsertedCount: number }>;
}

/** The algorithm a `source.hash` names (`sha256:<hex>`, sync/hash.ts), or null when it names none. */
function hashAlgorithm(hash: string | null | undefined): string | null {
  return /^([a-z0-9]+):/.exec(hash ?? '')?.[1] ?? null;
}

/**
 * The stored copy's hash and the record's were made by different algorithms (`sha1:` before
 * `sha256:`): they can't be compared, though the record may well be unchanged.
 */
function hashedOtherwise(stored: string | null | undefined, record: string): boolean {
  const before = hashAlgorithm(stored);
  const now = hashAlgorithm(record);
  return before !== null && now !== null && before !== now;
}

/** What every write sets, unchanged ones too: never a change. */
const ALWAYS_WRITTEN = new Set(['lastSeenAt', 'syncResource']);
/** `source` fields a hash leaves out (sync/hash.ts): they change without the record changing. */
const VOLATILE_SOURCE = new Set(['hash', 'etag', 'updatedAtSource']);

/**
 * A value inside a field (what `props` holds, at any depth) as the comparison reads it, the write's
 * and the stored copy's alike: the way the hash (stableStringify) reads a mapped record, with what
 * storage changes undone. MongoDB keeps an undefined under a key as null, where the hash drops it,
 * and an invalid date as the Unix epoch, where the hash reads null (as it reads NaN and ±Infinity).
 * So here an invalid or epoch date and a number that is not finite read as null, and a key that
 * reads as null counts as missing. Whatever the old hash found equal reads equal, whichever form
 * each side holds it in; the price is that inside a field a null, a missing key and the epoch are
 * one value.
 */
function asHashed(value: unknown): unknown {
  if (value instanceof Date) {
    const time = value.getTime();
    return Number.isNaN(time) || time === 0 ? null : value;
  }
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (Array.isArray(value)) return value.map(asHashed);
  if (typeof value === 'object' && value !== null) {
    const kept: Record<string, unknown> = {};
    for (const [key, child] of Object.entries(value)) {
      const read = asHashed(child);
      if (read !== null && read !== undefined) kept[key] = read;
    }
    return kept;
  }
  return value;
}

/**
 * What a write of `set` changes, read from `doc` (the write itself, or the stored copy) as one
 * comparable string: every field `set` writes but ALWAYS_WRITTEN, `source` without its volatile
 * fields, what a field holds read by asHashed. The same string for both whenever the old hash
 * would have matched; otherwise only when the write changes no stored field the hash covers (inside
 * a field, null, missing and the epoch aside).
 */
function changedBy(set: Record<string, unknown>, doc: Record<string, unknown>): string {
  const picked: Record<string, unknown> = {};
  for (const [field, written] of Object.entries(set)) {
    if (ALWAYS_WRITTEN.has(field)) continue;
    const value = doc[field] ?? null;
    if (field === 'source' && typeof written === 'object' && written !== null) {
      const stored = (typeof value === 'object' && value !== null ? value : {}) as Record<
        string,
        unknown
      >;
      const source: Record<string, unknown> = {};
      for (const key of Object.keys(written)) {
        if (!VOLATILE_SOURCE.has(key)) source[key] = stored[key] ?? null;
      }
      picked[field] = source;
    } else {
      // A top-level date is a typed field, and Mongoose refuses an invalid one: read as it is.
      picked[field] = value instanceof Date ? value : asHashed(value);
    }
  }
  return stableStringify(picked);
}

function sourceKey(integrationId: string | null | undefined, source: SourceRef): string {
  return JSON.stringify([
    integrationId ?? null,
    source.provider,
    source.accountId,
    source.externalId,
  ]);
}

/**
 * One `$in` of external ids per (integration, provider, account), so each branch uses the
 * natural-key index.
 */
function storedSourcesFilter(
  workspaceId: string,
  records: readonly SourceRecord[],
): mongoose.FilterQuery<StoredSource> {
  const groups = new Map<
    string,
    { integrationId: string; provider: Provider; accountId: string; ids: string[] }
  >();
  for (const { integrationId, source } of records) {
    const key = JSON.stringify([integrationId, source.provider, source.accountId]);
    const group = groups.get(key) ?? {
      integrationId,
      provider: source.provider,
      accountId: source.accountId,
      ids: [],
    };
    group.ids.push(source.externalId);
    groups.set(key, group);
  }
  return {
    workspaceId,
    $or: [...groups.values()].map((group) => ({
      'source.provider': group.provider,
      'source.accountId': group.accountId,
      'source.externalId': { $in: group.ids },
      integrationId: group.integrationId,
    })),
  };
}

/**
 * Natural-key bulk upsert of mapped provider records (DATA.md §4), keyed on (workspaceId,
 * source.provider, source.accountId, source.externalId, integrationId): two members who connect
 * the same account each keep their own copies (PERMISSIONS-V2 ruling 8):
 * - a live stored copy with the same non-null `source.hash` only gets `lastSeenAt` and
 *   `syncResource`, without an `updatedAt` bump (unchanged);
 * - a live stored copy whose hash another algorithm made (`sha1:`, before `sha256:`) is compared
 *   field by field instead (changedBy), equivalent on what is stored: a copy the old hash would
 *   have matched, or one the write would change no stored field of that the hash covers, is
 *   unchanged too and only takes the new hash, so a change of algorithm rewrites no record
 *   (DATA.md §4);
 * - so does a record signalling a delete (`deletedAt`) whose stored copy is already deleted: its
 *   `deletedAt`, the purge clock, is kept (unchanged);
 * - anything else is written in full, `$set: toSet(record)` with `$setOnInsert: {_id}`, which
 *   also restores a soft-deleted copy (updated, or inserted). `onWrite` sees each of those
 *   records with its stored copy (undefined for an insert), before the write.
 */
export async function upsertBySource<T extends SourceRecord, S extends StoredSource>(
  workspaceId: string,
  records: readonly T[],
  store: SourceUpsertStore<S>,
  toSet: (record: T, seenAt: Date) => Record<string, unknown>,
  onWrite?: (record: T, stored: S | undefined) => void,
  options: BulkUpsertOptions = {},
): Promise<BulkUpsertResult> {
  if (records.length === 0) return { inserted: 0, updated: 0, unchanged: 0 };
  const seenAt = new Date();
  const stored = new Map(
    (options.assumeNew === true
      ? []
      : await store.findStored(storedSourcesFilter(workspaceId, records))
    ).map((doc) => [sourceKey(doc.integrationId, doc.source), doc]),
  );

  /** `hash`: the record's, written over a stored hash of another algorithm. */
  const unchanged: { _id: string; syncResource: string | null; hash?: string }[] = [];
  const changed: T[] = [];
  const rehashed: { record: T; current: S; hash: string }[] = [];
  for (const record of records) {
    const current = stored.get(sourceKey(record.integrationId, record.source));
    const storedDeleted = current !== undefined && (current.deletedAt ?? null) !== null;
    const signalsDelete = (record.deletedAt ?? null) !== null;
    const live = current !== undefined && !storedDeleted && !signalsDelete;
    const same = live && record.source.hash !== null && record.source.hash === current.source.hash;
    if (same || (storedDeleted && signalsDelete)) {
      unchanged.push({ _id: current._id, syncResource: record.syncResource ?? null });
    } else if (
      live &&
      record.source.hash !== null &&
      hashedOtherwise(current.source.hash, record.source.hash)
    ) {
      rehashed.push({ record, current, hash: record.source.hash });
    } else {
      changed.push(record);
      onWrite?.(record, current);
    }
  }
  if (rehashed.length > 0) {
    const written = new Map(
      (
        await store.findWritten({
          workspaceId,
          _id: { $in: rehashed.map(({ current }) => current._id) },
        })
      ).map((doc) => [doc['_id'], doc]),
    );
    for (const { record, current, hash } of rehashed) {
      const set = toSet(record, seenAt);
      const doc = written.get(current._id);
      if (doc !== undefined && changedBy(set, set) === changedBy(set, doc)) {
        unchanged.push({ _id: current._id, syncResource: record.syncResource ?? null, hash });
      } else {
        changed.push(record);
        onWrite?.(record, current);
      }
    }
  }

  const { upsertedCount } = await store.bulkWrite([
    ...unchanged.map(({ _id, syncResource, hash }) => ({
      updateOne: {
        filter: { _id, workspaceId },
        update: {
          $set: {
            lastSeenAt: seenAt,
            syncResource,
            ...(hash === undefined ? {} : { 'source.hash': hash }),
          },
        },
        timestamps: false,
      },
    })),
    ...changed.map((record) => ({
      updateOne: {
        filter: {
          workspaceId,
          'source.provider': record.source.provider,
          'source.accountId': record.source.accountId,
          'source.externalId': record.source.externalId,
          integrationId: record.integrationId,
        },
        update: { $set: toSet(record, seenAt), $setOnInsert: { _id: record.id ?? randomUUID() } },
        upsert: true,
      },
    })),
  ]);
  return {
    inserted: upsertedCount,
    updated: changed.length - upsertedCount,
    unchanged: unchanged.length,
  };
}

/**
 * The filter of the orphaned-resource sweep: this integration's live records stamped with a
 * resource other than the listed ones (`$nin` with null also leaves out records with none), minus
 * the kept external ids.
 */
export function orphanedResourcesFilter(
  workspaceId: string,
  integrationId: string,
  resources: readonly string[],
  keepExternalIds: readonly string[],
): Record<string, unknown> {
  return {
    ...(keepExternalIds.length > 0 ? { 'source.externalId': { $nin: [...keepExternalIds] } } : {}),
    workspaceId,
    integrationId,
    syncResource: { $nin: [null, ...resources] },
    deletedAt: null,
  };
}

/**
 * Delete-only records (a provider's delete signal that carries only ids): sets `deletedAt` on the
 * live stored copies of these external ids of one integration's provider account, by the natural
 * key, and changes nothing else (another member's copies wait for their own sync). Copies already deleted keep their `deletedAt` (the purge clock); ids with
 * no stored copy are ignored.
 */
export async function softDeleteBySource<T>(
  model: mongoose.Model<T>,
  workspaceId: string,
  account: SourceAccount,
  externalIds: readonly string[],
  deletedAt: Date,
): Promise<SourceDeleteResult> {
  const ids = [...new Set(externalIds)];
  if (ids.length === 0) return { deleted: 0, alreadyDeleted: 0 };
  const scope = {
    workspaceId,
    'source.provider': account.provider,
    'source.accountId': account.accountId,
    'source.externalId': { $in: ids },
    integrationId: account.integrationId,
  };
  // Counted first: a copy this call deletes is never counted as deleted already.
  const alreadyDeleted = await model.countDocuments({ ...scope, deletedAt: { $ne: null } });
  const { modifiedCount } = await model.updateMany(
    { ...scope, deletedAt: null },
    { $set: { deletedAt } },
  );
  return { deleted: modifiedCount, alreadyDeleted };
}
