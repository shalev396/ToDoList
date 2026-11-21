import mongoose from 'mongoose';

import { RULE_DIRECTIONS, TRAVEL_MODES } from '../../types/travel.js';
import {
  TRAVEL_RULE_TABLE_NAME,
  type ITravelRuleRepository,
  type TravelRuleData,
  type TravelRulePatch,
} from '../definitions/TravelRule.js';
import { setFields, uuidIdField } from './common.js';

type TravelRuleFields = Omit<TravelRuleData, 'id'> & { _id: string };

const travelRuleSchema = new mongoose.Schema<TravelRuleFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    // `{kind: 'where', where}`, `{kind: 'series', itemId}` or `{kind: 'item', itemId, occurrence}` or
    // `{kind: 'repeats', containerId, title, weekday, startTime, from}`.
    scope: { type: mongoose.Schema.Types.Mixed, required: true },
    mode: { type: String, enum: TRAVEL_MODES, required: true },
    direction: { type: String, enum: RULE_DIRECTIONS, required: true },
    placeId: { type: String, default: null },
    // Optional: a rule stored before they existed has neither, and reads as null.
    arriveEarlyMinutes: { type: Number, default: null },
    lengths: { type: mongoose.Schema.Types.Mixed, default: null },
  },
  // minimize: false keeps an empty where-group's objects as they are.
  { timestamps: true, collection: TRAVEL_RULE_TABLE_NAME, minimize: false },
);

travelRuleSchema.index({ workspaceId: 1, ownerUserId: 1, createdAt: 1 }); // the member's rules, in order

export const TravelRuleMongoModel = mongoose.model<TravelRuleFields>(
  'TravelRule',
  travelRuleSchema,
);

const PATCH_KEYS: readonly (keyof TravelRulePatch)[] = [
  'scope',
  'mode',
  'direction',
  'placeId',
  'arriveEarlyMinutes',
  'lengths',
];

function toTravelRuleData(doc: TravelRuleFields): TravelRuleData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    ownerUserId: doc.ownerUserId,
    scope: doc.scope,
    mode: doc.mode,
    direction: doc.direction,
    placeId: doc.placeId ?? null,
    arriveEarlyMinutes: doc.arriveEarlyMinutes ?? null,
    lengths: doc.lengths ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const TravelRuleRepository: ITravelRuleRepository = {
  async create(workspaceId, input) {
    const doc = await TravelRuleMongoModel.create({
      workspaceId,
      ownerUserId: input.ownerUserId,
      scope: input.scope,
      mode: input.mode,
      direction: input.direction,
      placeId: input.placeId,
      arriveEarlyMinutes: input.arriveEarlyMinutes,
      lengths: input.lengths,
    });
    return toTravelRuleData(doc);
  },

  async findOwn(workspaceId, ownerUserId, id) {
    const doc = await TravelRuleMongoModel.findOne({
      _id: id,
      workspaceId,
      ownerUserId,
    }).lean<TravelRuleFields>();
    return doc ? toTravelRuleData(doc) : null;
  },

  async listOwn(workspaceId, ownerUserId) {
    const docs = await TravelRuleMongoModel.find({ workspaceId, ownerUserId })
      .sort({ createdAt: 1, _id: 1 })
      .lean<TravelRuleFields[]>();
    return docs.map(toTravelRuleData);
  },

  async countOwn(workspaceId, ownerUserId) {
    return TravelRuleMongoModel.countDocuments({ workspaceId, ownerUserId });
  },

  async update(workspaceId, ownerUserId, id, patch) {
    const doc = await TravelRuleMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, ownerUserId },
      { $set: setFields(patch, PATCH_KEYS) },
      { new: true, runValidators: true },
    ).lean<TravelRuleFields>();
    return doc ? toTravelRuleData(doc) : null;
  },

  async delete(workspaceId, ownerUserId, id) {
    const result = await TravelRuleMongoModel.deleteOne({ _id: id, workspaceId, ownerUserId });
    return result.deletedCount > 0;
  },

  async clearPlace(workspaceId, ownerUserId, placeId) {
    const result = await TravelRuleMongoModel.updateMany(
      { workspaceId, ownerUserId, placeId },
      { $set: { placeId: null } },
    );
    return result.modifiedCount;
  },

  async deleteRepeatsIn(workspaceId, containerIds) {
    if (containerIds.length === 0) return 0;
    const result = await TravelRuleMongoModel.deleteMany({
      workspaceId,
      'scope.kind': 'repeats',
      'scope.containerId': { $in: [...containerIds] },
    });
    return result.deletedCount;
  },

  async deleteForMember(workspaceId, ownerUserId) {
    const result = await TravelRuleMongoModel.deleteMany({ workspaceId, ownerUserId });
    return result.deletedCount;
  },

  async deleteForWorkspace(workspaceId) {
    const result = await TravelRuleMongoModel.deleteMany({ workspaceId });
    return result.deletedCount;
  },
};
