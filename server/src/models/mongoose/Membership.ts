import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

import { MEMBERSHIP_STATUSES, ROLES } from '../../types/domain.js';
import {
  MEMBERSHIP_TABLE_NAME,
  type IMembershipRepository,
  type MembershipData,
} from '../definitions/Membership.js';
import { setFields, uuidIdField } from './common.js';

type MembershipFields = Omit<MembershipData, 'id'> & { _id: string };

const membershipSchema = new mongoose.Schema<MembershipFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    role: { type: String, enum: ROLES, required: true },
    invitedBy: { type: String, default: null },
    status: { type: String, enum: MEMBERSHIP_STATUSES, default: 'active' },
  },
  { timestamps: true, collection: MEMBERSHIP_TABLE_NAME },
);

membershipSchema.index({ workspaceId: 1, userId: 1 }, { unique: true });
membershipSchema.index({ userId: 1, status: 1 });

export const MembershipMongoModel = mongoose.model<MembershipFields>(
  'Membership',
  membershipSchema,
);

function toMembershipData(doc: MembershipFields): MembershipData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    userId: doc.userId,
    role: doc.role,
    invitedBy: doc.invitedBy ?? null,
    status: doc.status,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const MembershipRepository: IMembershipRepository = {
  async create(workspaceId, input) {
    // One document per (workspaceId, userId): a revoked one is reactivated, otherwise a new one
    // is inserted, and an active one makes that insert fail on the unique index.
    const doc = await MembershipMongoModel.findOneAndUpdate(
      { workspaceId, userId: input.userId, status: 'revoked' },
      {
        $set: {
          role: input.role,
          invitedBy: input.invitedBy ?? null,
          status: 'active',
        },
        $setOnInsert: { _id: randomUUID() },
      },
      { upsert: true, new: true, runValidators: true },
    ).lean<MembershipFields>();
    return toMembershipData(doc);
  },

  async find(workspaceId, userId) {
    const doc = await MembershipMongoModel.findOne({
      workspaceId,
      userId,
      status: 'active',
    }).lean<MembershipFields>();
    return doc ? toMembershipData(doc) : null;
  },

  async listMembers(workspaceId) {
    const docs = await MembershipMongoModel.find({ workspaceId, status: 'active' })
      .sort({ createdAt: 1 })
      .lean<MembershipFields[]>();
    return docs.map(toMembershipData);
  },

  async update(workspaceId, userId, patch) {
    const doc = await MembershipMongoModel.findOneAndUpdate(
      { workspaceId, userId, status: 'active' },
      { $set: setFields(patch, ['role']) },
      { new: true, runValidators: true },
    ).lean<MembershipFields>();
    return doc ? toMembershipData(doc) : null;
  },

  async revoke(workspaceId, userId) {
    const result = await MembershipMongoModel.updateOne(
      { workspaceId, userId, status: 'active' },
      { $set: { status: 'revoked' } },
    );
    return result.modifiedCount > 0;
  },

  async countActive(workspaceId) {
    return MembershipMongoModel.countDocuments({ workspaceId, status: 'active' });
  },

  async countOwners(workspaceId) {
    return MembershipMongoModel.countDocuments({ workspaceId, status: 'active', role: 'owner' });
  },

  async findForUser(userId) {
    const docs = await MembershipMongoModel.find({ userId, status: 'active' })
      .sort({ createdAt: 1 })
      .lean<MembershipFields[]>();
    return docs.map(toMembershipData);
  },
};
