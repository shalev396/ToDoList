import mongoose from 'mongoose';

import { VISIBILITIES } from '../../types/domain.js';
import {
  VIEW_TABLE_NAME,
  type IViewRepository,
  type ViewData,
  type ViewPatch,
} from '../definitions/View.js';
import { setFields, uuidIdField } from './common.js';

type ViewFields = Omit<ViewData, 'id'> & { _id: string };

const viewSchema = new mongoose.Schema<ViewFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    title: { type: String, required: true },
    query: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, unknown> => ({}) },
    viz: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, unknown> => ({}) },
    visibility: { type: String, enum: VISIBILITIES, default: 'workspace' },
  },
  // minimize: false keeps empty `query` / `viz` as {} instead of dropping the fields.
  { timestamps: true, collection: VIEW_TABLE_NAME, minimize: false },
);

viewSchema.index({ workspaceId: 1, title: 1 });

export const ViewMongoModel = mongoose.model<ViewFields>('View', viewSchema);

const PATCH_KEYS: readonly (keyof ViewPatch)[] = ['title', 'query', 'viz', 'visibility'];

function toViewData(doc: ViewFields): ViewData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    ownerUserId: doc.ownerUserId,
    title: doc.title,
    query: doc.query,
    viz: doc.viz,
    visibility: doc.visibility,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const ViewRepository: IViewRepository = {
  async create(workspaceId, input) {
    const doc = await ViewMongoModel.create({
      workspaceId,
      ownerUserId: input.ownerUserId,
      title: input.title,
      query: input.query,
      viz: input.viz,
      ...setFields(input, ['visibility']),
    });
    return toViewData(doc);
  },

  async findById(workspaceId, id) {
    const doc = await ViewMongoModel.findOne({ _id: id, workspaceId }).lean<ViewFields>();
    return doc ? toViewData(doc) : null;
  },

  async list(workspaceId) {
    const docs = await ViewMongoModel.find({ workspaceId }).sort({ title: 1 }).lean<ViewFields[]>();
    return docs.map(toViewData);
  },

  async update(workspaceId, id, patch) {
    const doc = await ViewMongoModel.findOneAndUpdate(
      { _id: id, workspaceId },
      { $set: setFields(patch, PATCH_KEYS) },
      { new: true, runValidators: true },
    ).lean<ViewFields>();
    return doc ? toViewData(doc) : null;
  },

  async delete(workspaceId, id) {
    const result = await ViewMongoModel.deleteOne({ _id: id, workspaceId });
    return result.deletedCount > 0;
  },

  async deleteForWorkspace(workspaceId) {
    return (await ViewMongoModel.deleteMany({ workspaceId })).deletedCount;
  },

  async listWorkspaceIds() {
    return (await ViewMongoModel.distinct('workspaceId').read('primary')).map(String);
  },
};
