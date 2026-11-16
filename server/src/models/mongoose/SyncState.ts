import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

import {
  COUNTED_RUNS_KEPT,
  SYNC_STATE_TABLE_NAME,
  type ISyncStateRepository,
  type SyncStateData,
  type SyncStatePatch,
} from '../definitions/SyncState.js';
import { setFields, uuidIdField } from './common.js';

// `countedRunIds`: the runs countFailedRun() counted (`__run__` only), never part of the data.
type SyncStateFields = Omit<SyncStateData, 'id'> & { _id: string; countedRunIds?: string[] };

const syncStateSchema = new mongoose.Schema<SyncStateFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    integrationId: { type: String, required: true },
    resource: { type: String, required: true },
    cursor: { type: String, default: null },
    syncToken: { type: String, default: null },
    etag: { type: String, default: null },
    updatedSince: { type: Date, default: null },
    lastFullSyncAt: { type: Date, default: null },
    lastIncrementalAt: { type: Date, default: null },
    backoffUntil: { type: Date, default: null },
    consecutiveErrors: { type: Number, default: 0 },
    countedRunIds: { type: [String], default: undefined },
  },
  { timestamps: true, collection: SYNC_STATE_TABLE_NAME },
);

syncStateSchema.index({ integrationId: 1, resource: 1 }, { unique: true });

export const SyncStateMongoModel = mongoose.model<SyncStateFields>('SyncState', syncStateSchema);

/** MongoDB's E11000: the unique (integrationId, resource) index refused a second insert. */
function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

const PATCH_KEYS: readonly (keyof SyncStatePatch)[] = [
  'cursor',
  'syncToken',
  'etag',
  'updatedSince',
  'lastFullSyncAt',
  'lastIncrementalAt',
  'backoffUntil',
  'consecutiveErrors',
];

function toSyncStateData(doc: SyncStateFields): SyncStateData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    integrationId: doc.integrationId,
    resource: doc.resource,
    cursor: doc.cursor ?? null,
    syncToken: doc.syncToken ?? null,
    etag: doc.etag ?? null,
    updatedSince: doc.updatedSince ?? null,
    lastFullSyncAt: doc.lastFullSyncAt ?? null,
    lastIncrementalAt: doc.lastIncrementalAt ?? null,
    backoffUntil: doc.backoffUntil ?? null,
    consecutiveErrors: doc.consecutiveErrors,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const SyncStateRepository: ISyncStateRepository = {
  async get(workspaceId, integrationId, resource) {
    const doc = await SyncStateMongoModel.findOne({
      workspaceId,
      integrationId,
      resource,
    }).lean<SyncStateFields>();
    return doc ? toSyncStateData(doc) : null;
  },

  async upsert(workspaceId, integrationId, resource, patch) {
    const doc = await SyncStateMongoModel.findOneAndUpdate(
      { workspaceId, integrationId, resource },
      { $set: setFields(patch, PATCH_KEYS), $setOnInsert: { _id: randomUUID() } },
      { upsert: true, new: true, runValidators: true },
    ).lean<SyncStateFields>();
    return toSyncStateData(doc);
  },

  async listForIntegrations(workspaceId, integrationIds) {
    if (integrationIds.length === 0) return [];
    const docs = await SyncStateMongoModel.find({
      workspaceId,
      integrationId: { $in: [...integrationIds] },
    }).lean<SyncStateFields[]>();
    return docs.map(toSyncStateData);
  },

  // upsert()'s writes, but nothing validates it: a bulk write runs no update validators, and
  // this collection has no $jsonSchema validator (models/validators.ts). A batch door of the demo
  // seed: its callers write values they built and typed.
  async upsertMany(workspaceId, entries) {
    if (entries.length === 0) return;
    await SyncStateMongoModel.bulkWrite(
      entries.map(({ integrationId, resource, patch }) => ({
        updateOne: {
          filter: { workspaceId, integrationId, resource },
          update: { $set: setFields(patch, PATCH_KEYS), $setOnInsert: { _id: randomUUID() } },
          upsert: true,
        },
      })),
      { ordered: true },
    );
  },

  async countFailedRun(workspaceId, integrationId, resource, runId) {
    const scope = { workspaceId, integrationId, resource };
    // The state exists first, so the counting write below is a plain conditional update.
    try {
      await SyncStateMongoModel.updateOne(
        scope,
        { $setOnInsert: { _id: randomUUID() } },
        { upsert: true },
      );
    } catch (error) {
      // A concurrent first count inserted it meanwhile.
      if (!isDuplicateKey(error)) throw error;
    }
    const doc = await SyncStateMongoModel.findOneAndUpdate(
      { ...scope, countedRunIds: { $ne: runId } },
      {
        $inc: { consecutiveErrors: 1 },
        $push: { countedRunIds: { $each: [runId], $slice: -COUNTED_RUNS_KEPT } },
      },
      { new: true },
    ).lean<SyncStateFields>();
    return doc === null ? null : doc.consecutiveErrors;
  },
};
