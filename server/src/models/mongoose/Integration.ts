import mongoose from 'mongoose';

import {
  AUTH_METHODS,
  INTEGRATION_MODES,
  INTEGRATION_STATUSES,
  PROVIDERS,
  type IntegrationStatus,
} from '../../types/domain.js';
import {
  HELD_INTEGRATION_STATUSES,
  INTEGRATION_TABLE_NAME,
  PENDING_ACCOUNT_PREFIX,
  type CreateIntegrationInput,
  type IIntegrationRepository,
  type IntegrationData,
  type IntegrationPatch,
} from '../definitions/Integration.js';
import { ErrorInfoSchema, setFields, uuidIdField } from './common.js';

type IntegrationFields = Omit<IntegrationData, 'id' | 'demo'> & {
  _id: string;
  /** Absent on documents written before the flag: not demo data. */
  demo?: boolean;
  /** Deleted by its workspace's deletion (listOwnersForWorkspaceDeletion); internal. */
  deletedWithWorkspace?: boolean;
};

const integrationSchema = new mongoose.Schema<IntegrationFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    connectedBy: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    provider: { type: String, enum: PROVIDERS, required: true },
    accountId: { type: String, required: true },
    label: { type: String, required: true },
    authMethod: { type: String, enum: AUTH_METHODS, required: true },
    topicId: { type: String, default: null },
    mode: { type: String, enum: INTEGRATION_MODES, default: 'read' },
    config: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, unknown> => ({}) },
    credentialId: { type: String, default: null },
    status: { type: String, enum: INTEGRATION_STATUSES, default: 'active' },
    expiresAt: { type: Date, default: null },
    lastSyncAt: { type: Date, default: null },
    lastError: { type: ErrorInfoSchema, default: null },
    color: { type: String, default: null },
    demo: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    deletedWithWorkspace: { type: Boolean },
  },
  // minimize: false keeps an empty `config` as {} instead of dropping the field.
  { timestamps: true, collection: INTEGRATION_TABLE_NAME, minimize: false },
);

// PERMISSIONS-V2 ruling 8: two members may each connect the same account; one member, once.
integrationSchema.index(
  { workspaceId: 1, ownerUserId: 1, provider: 1, accountId: 1 },
  { unique: true, partialFilterExpression: { deletedAt: null } },
);
integrationSchema.index({ status: 1, expiresAt: 1 });

export const IntegrationMongoModel = mongoose.model<IntegrationFields>(
  'Integration',
  integrationSchema,
);

const PATCH_KEYS: readonly (keyof IntegrationPatch)[] = [
  'label',
  'topicId',
  'mode',
  'config',
  'credentialId',
  'status',
  'expiresAt',
  'lastSyncAt',
  'lastError',
  'color',
];

/**
 * Scheduled by the sync dispatcher; `expired` and `paused` wait for the user, and so does any
 * integration whose last error is `auth_failed`.
 */
const DISPATCH_STATUSES: readonly IntegrationStatus[] = ['active', 'expiring', 'error'];

function toIntegrationData(doc: IntegrationFields): IntegrationData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    connectedBy: doc.connectedBy,
    // Never filled in from connectedBy: a document the owners migration missed is nobody's own
    // (and in no list or cap), so a missed migration shows instead of hiding.
    ownerUserId: doc.ownerUserId,
    provider: doc.provider,
    accountId: doc.accountId,
    label: doc.label,
    authMethod: doc.authMethod,
    topicId: doc.topicId ?? null,
    mode: doc.mode,
    config: doc.config,
    credentialId: doc.credentialId ?? null,
    status: doc.status,
    expiresAt: doc.expiresAt ?? null,
    lastSyncAt: doc.lastSyncAt ?? null,
    lastError: doc.lastError ? { code: doc.lastError.code, message: doc.lastError.message } : null,
    color: doc.color ?? null,
    demo: doc.demo === true,
    deletedAt: doc.deletedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** A new integration's document (the schema fills in what it leaves out). */
function integrationDoc(
  workspaceId: string,
  input: CreateIntegrationInput,
): Record<string, unknown> {
  return {
    workspaceId,
    connectedBy: input.connectedBy,
    ownerUserId: input.ownerUserId ?? input.connectedBy,
    provider: input.provider,
    accountId: input.accountId,
    label: input.label,
    authMethod: input.authMethod,
    topicId: input.topicId,
    ...setFields(input, [
      'mode',
      'config',
      'credentialId',
      'status',
      'lastError',
      'expiresAt',
      'color',
      'demo',
    ]),
  };
}

export const IntegrationRepository: IIntegrationRepository = {
  async create(workspaceId, input) {
    const doc = await IntegrationMongoModel.create(integrationDoc(workspaceId, input));
    return toIntegrationData(doc);
  },

  async createMany(workspaceId, inputs, at = new Date()) {
    if (inputs.length === 0) return [];
    const docs = await IntegrationMongoModel.insertMany(
      inputs.map(
        (input, index) =>
          new IntegrationMongoModel({
            ...integrationDoc(workspaceId, input),
            createdAt: new Date(at.getTime() + index),
          }),
      ),
      { ordered: true },
    );
    return docs.map((doc) => toIntegrationData(doc));
  },

  async findById(workspaceId, id) {
    const doc = await IntegrationMongoModel.findOne({
      _id: id,
      workspaceId,
      deletedAt: null,
    }).lean<IntegrationFields>();
    return doc ? toIntegrationData(doc) : null;
  },

  async findIncludingDeleted(workspaceId, id) {
    const doc = await IntegrationMongoModel.findOne({
      _id: id,
      workspaceId,
    }).lean<IntegrationFields>();
    return doc ? toIntegrationData(doc) : null;
  },

  async list(workspaceId) {
    const docs = await IntegrationMongoModel.find({ workspaceId, deletedAt: null })
      .sort({ createdAt: 1 })
      .lean<IntegrationFields[]>();
    return docs.map(toIntegrationData);
  },

  async listForOwner(workspaceId, ownerUserId) {
    const docs = await IntegrationMongoModel.find({ workspaceId, ownerUserId, deletedAt: null })
      .sort({ createdAt: 1 })
      .lean<IntegrationFields[]>();
    return docs.map(toIntegrationData);
  },

  async listForOwnerIncludingDeleted(workspaceId, ownerUserId) {
    const docs = await IntegrationMongoModel.find({ workspaceId, ownerUserId })
      .sort({ createdAt: 1 })
      .lean<IntegrationFields[]>();
    return docs.map(toIntegrationData);
  },

  async listByIdsIncludingDeleted(workspaceId, ids) {
    if (ids.length === 0) return [];
    const docs = await IntegrationMongoModel.find({
      workspaceId,
      _id: { $in: [...ids] },
    }).lean<IntegrationFields[]>();
    return docs.map(toIntegrationData);
  },

  async update(workspaceId, id, patch) {
    const doc = await IntegrationMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, deletedAt: null },
      { $set: setFields(patch, PATCH_KEYS) },
      { new: true, runValidators: true },
    ).lean<IntegrationFields>();
    return doc ? toIntegrationData(doc) : null;
  },

  // update()'s writes without its `runValidators` (a bulk write has none): the classes write
  // statuses and ids they know.
  async updateMany(workspaceId, updates) {
    if (updates.length === 0) return;
    await IntegrationMongoModel.bulkWrite(
      updates.map(({ id, patch }) => ({
        updateOne: {
          filter: { _id: id, workspaceId, deletedAt: null },
          update: { $set: setFields(patch, PATCH_KEYS) },
        },
      })),
      { ordered: true },
    );
  },

  async replacePendingAccount(workspaceId, id, accountId) {
    // The filter is the guard: only a live integration whose account is still a placeholder.
    const doc = await IntegrationMongoModel.findOneAndUpdate(
      {
        _id: id,
        workspaceId,
        deletedAt: null,
        accountId: { $regex: `^${PENDING_ACCOUNT_PREFIX}` },
      },
      { $set: { accountId } },
      { new: true, runValidators: true },
    ).lean<IntegrationFields>();
    return doc ? toIntegrationData(doc) : null;
  },

  async recordConnectionTest(workspaceId, id, patch) {
    const live = { _id: id, workspaceId, deletedAt: null };
    if (patch.label !== undefined) {
      // The filter is the guard: a label saved since the test read the default is kept.
      await IntegrationMongoModel.updateOne(
        { ...live, label: patch.label.from },
        { $set: { label: patch.label.to } },
        { runValidators: true },
      );
    }
    if (patch.boardsEnabled !== undefined) {
      // One field, never the whole config: a config PATCH that lands during the test is kept.
      // `config` and `config.boards` must be objects (or boards missing) for the dotted $set; an
      // embedded document only (`$type: 'object'` alone also matches an array's elements).
      const OBJECT = { $type: 'object', $not: { $type: 'array' } };
      await IntegrationMongoModel.updateOne(
        {
          ...live,
          provider: 'github',
          config: OBJECT,
          $or: [{ 'config.boards': { $exists: false } }, { 'config.boards': OBJECT }],
        },
        { $set: { 'config.boards.enabled': patch.boardsEnabled } },
      );
    }
  },

  async recordSyncResult(workspaceId, id, result) {
    const live = { _id: id, workspaceId, deletedAt: null };
    if (result.status !== undefined) {
      // Conditional: a pause or an expiry set meanwhile is never overwritten.
      await IntegrationMongoModel.updateOne(
        { ...live, status: { $nin: [...HELD_INTEGRATION_STATUSES] } },
        { $set: { status: result.status } },
        { runValidators: true },
      );
    }
    const doc = await IntegrationMongoModel.findOneAndUpdate(
      live,
      { $set: setFields(result, ['lastSyncAt', 'lastError']) },
      { new: true, runValidators: true },
    ).lean<IntegrationFields>();
    return doc ? toIntegrationData(doc) : null;
  },

  // recordSyncResult()'s writes, without its `runValidators` (a bulk write has none): the engine
  // writes a status it knows and its own times.
  async recordSyncResults(workspaceId, results) {
    if (results.length === 0) return;
    await IntegrationMongoModel.bulkWrite(
      results.flatMap(({ id, result }) => {
        const live = { _id: id, workspaceId, deletedAt: null };
        return [
          ...(result.status === undefined
            ? []
            : [
                {
                  updateOne: {
                    filter: { ...live, status: { $nin: [...HELD_INTEGRATION_STATUSES] } },
                    update: { $set: { status: result.status } },
                  },
                },
              ]),
          {
            updateOne: {
              filter: live,
              update: { $set: setFields(result, ['lastSyncAt', 'lastError']) },
            },
          },
        ];
      }),
      { ordered: true },
    );
  },

  async softDelete(workspaceId, id) {
    const result = await IntegrationMongoModel.updateOne(
      { _id: id, workspaceId, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  },

  async unsetTopic(workspaceId, topicId) {
    const result = await IntegrationMongoModel.updateMany(
      { workspaceId, topicId },
      { $set: { topicId: null } },
    );
    return result.modifiedCount;
  },

  async softDeleteForWorkspace(workspaceId) {
    const result = await IntegrationMongoModel.updateMany(
      { workspaceId, deletedAt: null },
      { $set: { deletedAt: new Date(), deletedWithWorkspace: true } },
    );
    return result.modifiedCount;
  },

  async listOwnersForWorkspaceDeletion(workspaceId) {
    const owners: unknown[] = await IntegrationMongoModel.distinct('ownerUserId', {
      workspaceId,
      $or: [{ deletedAt: null }, { deletedWithWorkspace: true }],
    });
    return owners.filter((owner): owner is string => typeof owner === 'string');
  },

  async countActive(workspaceId) {
    return IntegrationMongoModel.countDocuments({ workspaceId, deletedAt: null });
  },

  async countActiveForOwner(workspaceId, ownerUserId) {
    return IntegrationMongoModel.countDocuments({ workspaceId, ownerUserId, deletedAt: null });
  },

  async findByIdForWorker(id) {
    const doc = await IntegrationMongoModel.findOne({
      _id: id,
      deletedAt: null,
    }).lean<IntegrationFields>();
    return doc ? toIntegrationData(doc) : null;
  },

  async findIncludingDeletedForWorker(id) {
    const doc = await IntegrationMongoModel.findOne({ _id: id }).lean<IntegrationFields>();
    return doc ? toIntegrationData(doc) : null;
  },

  async listActiveForDispatch() {
    const docs = await IntegrationMongoModel.find({
      deletedAt: null,
      status: { $in: [...DISPATCH_STATUSES] },
      // Failed auth needs a reconnect: a scheduled retry would only fail again.
      'lastError.code': { $ne: 'auth_failed' },
      // Demo data never syncs (its credential is FAKE).
      demo: { $ne: true },
    }).lean<IntegrationFields[]>();
    return docs.map(toIntegrationData);
  },
};
