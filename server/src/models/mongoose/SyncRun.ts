import mongoose from 'mongoose';

import { SYNC_RUN_STATUSES, SYNC_TRIGGERS } from '../../types/domain.js';
import {
  SYNC_RUN_TABLE_NAME,
  type ISyncRunRepository,
  type SyncRunData,
  type SyncRunFailure,
  type SyncRunPatch,
} from '../definitions/SyncRun.js';
import { ErrorInfoSchema, setFields, uuidIdField } from './common.js';

// `failures` is optional as stored: runs written before it existed have none. (Runs written
// before T3.5 may also carry a `counted` flag, now unused: the `__run__` state counts runs.)
type SyncRunFields = Omit<SyncRunData, 'id' | 'failures'> & {
  _id: string;
  failures?: SyncRunFailure[];
};

const FailureSchema = new mongoose.Schema<SyncRunFailure>(
  {
    // '' is a valid id here (a record that came without one), which `required` would refuse.
    externalId: { type: String, default: '' },
    code: { type: String, required: true },
  },
  { _id: false },
);

/** Runs are removed 30 days after creation (TTL on `expireAt`). */
const RETENTION_MS = 30 * 24 * 60 * 60 * 1000;

const syncRunSchema = new mongoose.Schema<SyncRunFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    integrationId: { type: String, required: true },
    trigger: { type: String, enum: SYNC_TRIGGERS, required: true },
    startedAt: { type: Date, default: (): Date => new Date() },
    finishedAt: { type: Date, default: null },
    status: { type: String, enum: SYNC_RUN_STATUSES, default: 'queued' },
    counts: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, number> => ({}) },
    error: { type: ErrorInfoSchema, default: null },
    failures: { type: [FailureSchema], default: [] },
    expireAt: { type: Date, default: (): Date => new Date(Date.now() + RETENTION_MS) },
  },
  // minimize: false keeps empty `counts` as {} instead of dropping the field.
  { timestamps: true, collection: SYNC_RUN_TABLE_NAME, minimize: false },
);

syncRunSchema.index({ integrationId: 1, startedAt: -1 });
syncRunSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 });
// The purge job's stale-run reaper: only the (few) running runs are in it.
syncRunSchema.index({ startedAt: 1 }, { partialFilterExpression: { status: 'running' } });

export const SyncRunMongoModel = mongoose.model<SyncRunFields>('SyncRun', syncRunSchema);

const PATCH_KEYS: readonly (keyof SyncRunPatch)[] = [
  'status',
  'startedAt',
  'finishedAt',
  'counts',
  'error',
  'failures',
];

function toSyncRunData(doc: SyncRunFields): SyncRunData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    integrationId: doc.integrationId,
    trigger: doc.trigger,
    startedAt: doc.startedAt,
    finishedAt: doc.finishedAt ?? null,
    status: doc.status,
    counts: { ...doc.counts },
    error: doc.error ? { code: doc.error.code, message: doc.error.message } : null,
    failures: (doc.failures ?? []).map(({ externalId, code }) => ({ externalId, code })),
    expireAt: doc.expireAt,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const SyncRunRepository: ISyncRunRepository = {
  async create(workspaceId, input) {
    const doc = await SyncRunMongoModel.create({
      workspaceId,
      integrationId: input.integrationId,
      trigger: input.trigger,
      ...setFields(input, ['status', 'startedAt']),
    });
    return toSyncRunData(doc);
  },

  async createMany(workspaceId, inputs) {
    if (inputs.length === 0) return [];
    const docs = await SyncRunMongoModel.insertMany(
      inputs.map((input) => ({
        ...(input.id === undefined ? {} : { _id: input.id }),
        workspaceId,
        integrationId: input.integrationId,
        trigger: input.trigger,
        ...setFields(input, ['status', 'startedAt']),
      })),
      { ordered: true },
    );
    return docs.map((doc) => toSyncRunData(doc));
  },

  async update(workspaceId, id, patch) {
    const doc = await SyncRunMongoModel.findOneAndUpdate(
      { _id: id, workspaceId },
      { $set: setFields(patch, PATCH_KEYS) },
      { new: true, runValidators: true },
    ).lean<SyncRunFields>();
    return doc ? toSyncRunData(doc) : null;
  },

  // update()'s writes, but nothing validates it: a bulk write runs no update validators, and
  // this collection has no $jsonSchema validator (models/validators.ts). A batch door of the demo
  // seed: its callers write values they built and typed.
  async updateMany(workspaceId, updates) {
    if (updates.length === 0) return 0;
    const result = await SyncRunMongoModel.bulkWrite(
      updates.map(({ id, patch }) => ({
        updateOne: {
          filter: { _id: id, workspaceId },
          update: { $set: setFields(patch, PATCH_KEYS) },
        },
      })),
      { ordered: true },
    );
    return result.matchedCount;
  },

  async updateManyIfStatus(workspaceId, statuses, updates) {
    if (updates.length === 0) return 0;
    const result = await SyncRunMongoModel.bulkWrite(
      updates.map(({ id, patch }) => ({
        updateOne: {
          filter: { _id: id, workspaceId, status: { $in: [...statuses] } },
          update: { $set: setFields(patch, PATCH_KEYS) },
        },
      })),
      { ordered: true },
    );
    return result.modifiedCount;
  },

  async updateIfStatus(workspaceId, id, statuses, patch) {
    const doc = await SyncRunMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, status: { $in: [...statuses] } },
      { $set: setFields(patch, PATCH_KEYS) },
      { new: true, runValidators: true },
    ).lean<SyncRunFields>();
    return doc ? toSyncRunData(doc) : null;
  },

  // Global on purpose: the purge job ends stale runs in every workspace (jobs/purge.ts).
  async listRunningStartedBefore(before, limit) {
    const docs = await SyncRunMongoModel.find({ status: 'running', startedAt: { $lt: before } })
      .sort({ startedAt: 1 })
      .limit(limit)
      .lean<SyncRunFields[]>();
    return docs.map(toSyncRunData);
  },

  async findById(workspaceId, id) {
    const doc = await SyncRunMongoModel.findOne({ _id: id, workspaceId }).lean<SyncRunFields>();
    return doc ? toSyncRunData(doc) : null;
  },

  async listForIntegration(workspaceId, integrationId, limit) {
    const docs = await SyncRunMongoModel.find({ workspaceId, integrationId })
      .sort({ startedAt: -1 })
      .limit(limit)
      .lean<SyncRunFields[]>();
    return docs.map(toSyncRunData);
  },
};
