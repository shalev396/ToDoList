import mongoose from 'mongoose';

import { TOPIC_COLOURS, TOPIC_ICONS } from '../../types/topics.js';
import {
  TOPIC_TABLE_NAME,
  type ITopicRepository,
  type TopicData,
  type TopicPatch,
} from '../definitions/Topic.js';
import { setFields, uuidIdField } from './common.js';

type TopicFields = Omit<TopicData, 'id'> & { _id: string };

const topicSchema = new mongoose.Schema<TopicFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    name: { type: String, required: true },
    slug: { type: String, required: true },
    icon: { type: String, enum: [...TOPIC_ICONS, null], default: null },
    colour: { type: String, enum: [...TOPIC_COLOURS, null], default: null },
    order: { type: Number, required: true },
    createdBy: { type: String, default: null },
  },
  { timestamps: true, collection: TOPIC_TABLE_NAME },
);

// A slug names one topic of a workspace: its URL.
topicSchema.index({ workspaceId: 1, slug: 1 }, { unique: true });

export const TopicMongoModel = mongoose.model<TopicFields>('Topic', topicSchema);

const PATCH_KEYS: readonly (keyof TopicPatch)[] = ['name', 'icon', 'colour', 'order'];

function toTopicData(doc: TopicFields): TopicData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    name: doc.name,
    slug: doc.slug,
    icon: doc.icon ?? null,
    colour: doc.colour ?? null,
    order: doc.order,
    createdBy: doc.createdBy ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const TopicRepository: ITopicRepository = {
  async create(workspaceId, input) {
    const doc = await TopicMongoModel.create({
      ...(input.id === undefined ? {} : { _id: input.id }),
      workspaceId,
      name: input.name,
      slug: input.slug,
      icon: input.icon ?? null,
      colour: input.colour ?? null,
      order: input.order,
      createdBy: input.createdBy ?? null,
    });
    return toTopicData(doc.toObject());
  },

  async findById(workspaceId, id) {
    const doc = await TopicMongoModel.findOne({ _id: id, workspaceId }).lean<TopicFields>();
    return doc ? toTopicData(doc) : null;
  },

  async findBySlug(workspaceId, slug) {
    const doc = await TopicMongoModel.findOne({ workspaceId, slug }).lean<TopicFields>();
    return doc ? toTopicData(doc) : null;
  },

  async list(workspaceId) {
    const docs = await TopicMongoModel.find({ workspaceId })
      .sort({ order: 1, createdAt: 1, _id: 1 })
      .lean<TopicFields[]>();
    return docs.map(toTopicData);
  },

  async count(workspaceId) {
    return TopicMongoModel.countDocuments({ workspaceId });
  },

  async update(workspaceId, id, patch) {
    const doc = await TopicMongoModel.findOneAndUpdate(
      { _id: id, workspaceId },
      { $set: setFields(patch, PATCH_KEYS) },
      { new: true, runValidators: true },
    ).lean<TopicFields>();
    return doc ? toTopicData(doc) : null;
  },

  async delete(workspaceId, id) {
    const result = await TopicMongoModel.deleteOne({ _id: id, workspaceId });
    return result.deletedCount > 0;
  },

  async deleteForWorkspace(workspaceId) {
    return (await TopicMongoModel.deleteMany({ workspaceId })).deletedCount;
  },

  async listWorkspaceIds() {
    return (await TopicMongoModel.distinct('workspaceId').read('primary')).map(String);
  },
};
