import mongoose from 'mongoose';

import {
  PLACE_TABLE_NAME,
  type IPlaceRepository,
  type PlaceData,
  type PlacePatch,
} from '../definitions/Place.js';
import { setFields, uuidIdField } from './common.js';

type PlaceFields = Omit<PlaceData, 'id'> & { _id: string };

const placeSchema = new mongoose.Schema<PlaceFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    name: { type: String, required: true },
    aliases: { type: [String], default: [] },
    address: { type: String, default: null },
    home: { type: Boolean, default: false },
  },
  { timestamps: true, collection: PLACE_TABLE_NAME },
);

placeSchema.index({ workspaceId: 1, ownerUserId: 1, createdAt: 1 }); // the member's places
// One Home per member, held by the database itself.
placeSchema.index(
  { workspaceId: 1, ownerUserId: 1 },
  { unique: true, partialFilterExpression: { home: true } },
);

export const PlaceMongoModel = mongoose.model<PlaceFields>('Place', placeSchema);

const PATCH_KEYS: readonly (keyof PlacePatch)[] = ['name', 'aliases', 'address', 'home'];

function toPlaceData(doc: PlaceFields): PlaceData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    ownerUserId: doc.ownerUserId,
    name: doc.name,
    aliases: [...doc.aliases],
    address: doc.address ?? null,
    home: doc.home,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const PlaceRepository: IPlaceRepository = {
  async create(workspaceId, input) {
    const doc = await PlaceMongoModel.create({
      workspaceId,
      ownerUserId: input.ownerUserId,
      name: input.name,
      aliases: input.aliases,
      address: input.address,
      home: input.home,
    });
    return toPlaceData(doc);
  },

  async findOwn(workspaceId, ownerUserId, id) {
    const doc = await PlaceMongoModel.findOne({
      _id: id,
      workspaceId,
      ownerUserId,
    }).lean<PlaceFields>();
    return doc ? toPlaceData(doc) : null;
  },

  async listOwn(workspaceId, ownerUserId) {
    const docs = await PlaceMongoModel.find({ workspaceId, ownerUserId })
      .sort({ createdAt: 1, _id: 1 })
      .lean<PlaceFields[]>();
    return docs.map(toPlaceData);
  },

  async countOwn(workspaceId, ownerUserId) {
    return PlaceMongoModel.countDocuments({ workspaceId, ownerUserId });
  },

  async update(workspaceId, ownerUserId, id, patch) {
    const doc = await PlaceMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, ownerUserId },
      { $set: setFields(patch, PATCH_KEYS) },
      { new: true, runValidators: true },
    ).lean<PlaceFields>();
    return doc ? toPlaceData(doc) : null;
  },

  async clearHome(workspaceId, ownerUserId, exceptId) {
    const result = await PlaceMongoModel.updateMany(
      {
        workspaceId,
        ownerUserId,
        home: true,
        ...(exceptId === undefined ? {} : { _id: { $ne: exceptId } }),
      },
      { $set: { home: false } },
    );
    return result.modifiedCount;
  },

  async delete(workspaceId, ownerUserId, id) {
    const result = await PlaceMongoModel.deleteOne({ _id: id, workspaceId, ownerUserId });
    return result.deletedCount > 0;
  },

  async deleteForMember(workspaceId, ownerUserId) {
    const result = await PlaceMongoModel.deleteMany({ workspaceId, ownerUserId });
    return result.deletedCount;
  },

  async deleteForWorkspace(workspaceId) {
    const result = await PlaceMongoModel.deleteMany({ workspaceId });
    return result.deletedCount;
  },
};
