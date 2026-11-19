import mongoose from 'mongoose';

import { CONTAINER_TYPES } from '../../types/domain.js';
import {
  CONTAINER_TABLE_NAME,
  type ContainerData,
  type ContainerUpsert,
  type IContainerRepository,
} from '../definitions/Container.js';
import type { AggregateOptions } from '../definitions/common.js';
import {
  SourceSchema,
  scopedPipeline,
  orphanedResourcesFilter,
  setFields,
  softDeleteBySource,
  toSourceRef,
  upsertBySource,
  uuidIdField,
  type SourceUpsertStore,
  type StoredSource,
} from './common.js';

type ContainerFields = Omit<ContainerData, 'id'> & { _id: string };

const containerSchema = new mongoose.Schema<ContainerFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    integrationId: { type: String, required: true },
    topicId: { type: String, default: null },
    type: { type: String, enum: CONTAINER_TYPES, required: true },
    name: { type: String, required: true },
    parentId: { type: String, default: null },
    path: { type: [String], default: [] },
    source: { type: SourceSchema, required: true },
    syncResource: { type: String, default: null },
    props: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, unknown> => ({}) },
    hidden: { type: Boolean, default: false },
    deletedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
  },
  // minimize: false keeps an empty `props` as {} instead of dropping the field.
  { timestamps: true, collection: CONTAINER_TABLE_NAME, minimize: false },
);

containerSchema.index(
  {
    workspaceId: 1,
    'source.provider': 1,
    'source.accountId': 1,
    'source.externalId': 1,
    integrationId: 1,
  },
  { unique: true },
); // upsert key: one copy per integration (ruling 8)
containerSchema.index({ workspaceId: 1, type: 1, topicId: 1 });
containerSchema.index({ integrationId: 1, syncResource: 1, lastSeenAt: 1 }); // per-resource sweep

export const ContainerMongoModel = mongoose.model<ContainerFields>('Container', containerSchema);

function toContainerData(doc: ContainerFields): ContainerData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    integrationId: doc.integrationId,
    topicId: doc.topicId ?? null,
    type: doc.type,
    name: doc.name,
    parentId: doc.parentId ?? null,
    path: [...doc.path],
    source: toSourceRef(doc.source),
    syncResource: doc.syncResource ?? null,
    props: doc.props,
    hidden: doc.hidden,
    deletedAt: doc.deletedAt ?? null,
    lastSeenAt: doc.lastSeenAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Every field the sync owns; left-out values are cleared. `hidden` belongs to users. */
function syncedContainerFields(container: ContainerUpsert, seenAt: Date): Record<string, unknown> {
  return {
    integrationId: container.integrationId,
    topicId: container.topicId,
    type: container.type,
    name: container.name,
    parentId: container.parentId ?? null,
    path: container.path ?? [],
    source: toSourceRef(container.source),
    syncResource: container.syncResource ?? null,
    props: container.props ?? {},
    deletedAt: container.deletedAt ?? null,
    lastSeenAt: seenAt,
  };
}

const containerStore: SourceUpsertStore = {
  findStored: (filter) =>
    ContainerMongoModel.find(filter, { integrationId: 1, source: 1, deletedAt: 1 })
      .lean<StoredSource[]>()
      .exec(),
  findWritten: (filter) =>
    ContainerMongoModel.find(filter).lean<Record<string, unknown>[]>().exec(),
  bulkWrite: (writes) => ContainerMongoModel.bulkWrite(writes),
};

export const ContainerRepository: IContainerRepository = {
  async findById(workspaceId, id) {
    const doc = await ContainerMongoModel.findOne({
      _id: id,
      workspaceId,
      deletedAt: null,
    }).lean<ContainerFields>();
    return doc ? toContainerData(doc) : null;
  },

  async list(workspaceId, filter) {
    const docs = await ContainerMongoModel.find({
      ...setFields(filter, ['type', 'topicId', 'integrationId']),
      ...(filter.externalIds === undefined
        ? {}
        : { 'source.externalId': { $in: [...filter.externalIds] } }),
      workspaceId,
      deletedAt: null,
    })
      .sort({ name: 1 })
      .lean<ContainerFields[]>();
    return docs.map(toContainerData);
  },

  async bulkUpsert(workspaceId, docs, options = {}) {
    return upsertBySource(
      workspaceId,
      docs,
      containerStore,
      syncedContainerFields,
      undefined,
      options,
    );
  },

  async softDeleteBySource(workspaceId, account, externalIds, deletedAt = new Date()) {
    return softDeleteBySource(ContainerMongoModel, workspaceId, account, externalIds, deletedAt);
  },

  async unsetTopic(workspaceId, topicId) {
    const result = await ContainerMongoModel.updateMany(
      { workspaceId, topicId },
      { $set: { topicId: null } },
    );
    return result.modifiedCount;
  },

  async setTopics(workspaceId, changes) {
    if (changes.length === 0) return 0;
    const result = await ContainerMongoModel.bulkWrite(
      changes.map(({ id, topicId }) => ({
        updateOne: {
          filter: { _id: id, workspaceId, deletedAt: null, topicId: { $ne: topicId } },
          update: { $set: { topicId } },
        },
      })),
    );
    return result.modifiedCount;
  },

  async softDeleteForWorkspace(workspaceId) {
    const result = await ContainerMongoModel.updateMany(
      { workspaceId, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
    return result.modifiedCount;
  },

  async sweepUnseen(workspaceId, integrationId, resource, before, options = {}) {
    const { deletedAt = new Date(), keepExternalIds = [] } = options;
    const result = await ContainerMongoModel.updateMany(
      {
        ...(keepExternalIds.length > 0
          ? { 'source.externalId': { $nin: [...keepExternalIds] } }
          : {}),
        workspaceId,
        integrationId,
        syncResource: resource,
        deletedAt: null,
        lastSeenAt: { $lt: before },
      },
      { $set: { deletedAt } },
    );
    return result.modifiedCount;
  },

  async sweepOrphanedResources(workspaceId, integrationId, resources, options = {}) {
    const { deletedAt = new Date(), keepExternalIds = [] } = options;
    const result = await ContainerMongoModel.updateMany(
      orphanedResourcesFilter(workspaceId, integrationId, resources, keepExternalIds),
      { $set: { deletedAt } },
    );
    return result.modifiedCount;
  },

  async countLiveByIntegration(workspaceId, integrationIds) {
    const counts = new Map(integrationIds.map((id) => [id, 0]));
    if (integrationIds.length === 0) return counts;
    const rows = await ContainerMongoModel.aggregate<{ _id: string; n: number }>([
      { $match: { workspaceId, integrationId: { $in: [...integrationIds] }, deletedAt: null } },
      { $group: { _id: '$integrationId', n: { $sum: 1 } } },
    ]);
    for (const { _id, n } of rows) counts.set(_id, n);
    return counts;
  },

  async existsForIntegrations(workspaceId, integrationIds) {
    if (integrationIds.length === 0) return false;
    const found = await ContainerMongoModel.exists({
      workspaceId,
      integrationId: { $in: [...integrationIds] },
    });
    return found !== null;
  },

  async softDeleteForIntegration(workspaceId, integrationId, deletedAt = new Date()) {
    const result = await ContainerMongoModel.updateMany(
      { workspaceId, integrationId, deletedAt: null },
      { $set: { deletedAt } },
    );
    return result.modifiedCount;
  },

  // Global on purpose: the purge job runs over every workspace (jobs/purge.ts).
  async purgeDeletedBefore(date) {
    const result = await ContainerMongoModel.deleteMany({ deletedAt: { $lt: date } });
    return result.deletedCount;
  },

  async aggregate<T>(
    workspaceId: string,
    stages: readonly Record<string, unknown>[],
    options: AggregateOptions = {},
  ) {
    return ContainerMongoModel.aggregate<T>(scopedPipeline(workspaceId, stages), {
      ...options,
    }).exec();
  },
};
