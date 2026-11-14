import mongoose from 'mongoose';

import { INVITE_STATUSES, ROLES } from '../../types/domain.js';
import {
  INVITE_TABLE_NAME,
  type IInviteRepository,
  type InviteData,
} from '../definitions/Invite.js';
import { uuidIdField } from './common.js';

type InviteFields = Omit<InviteData, 'id'> & { _id: string; tokenHash: string };

const inviteSchema = new mongoose.Schema<InviteFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    email: { type: String, required: true, lowercase: true, trim: true },
    role: { type: String, enum: ROLES, required: true },
    tokenHash: { type: String, required: true },
    expiresAt: { type: Date, required: true },
    status: { type: String, enum: INVITE_STATUSES, default: 'pending' },
    invitedBy: { type: String, required: true },
    acceptedBy: { type: String, default: null },
    acceptedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: INVITE_TABLE_NAME },
);

inviteSchema.index({ tokenHash: 1 }, { unique: true });
inviteSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
// C1 (beyond DATA.md §6): onboarding lists pending invites by email.
inviteSchema.index({ email: 1, status: 1 });

export const InviteMongoModel = mongoose.model<InviteFields>('Invite', inviteSchema);

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

/** Everything but the token hash, which never leaves the repository. */
function toInviteData(doc: InviteFields): InviteData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    email: doc.email,
    role: doc.role,
    expiresAt: doc.expiresAt,
    status: doc.status,
    invitedBy: doc.invitedBy,
    acceptedBy: doc.acceptedBy ?? null,
    acceptedAt: doc.acceptedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const InviteRepository: IInviteRepository = {
  async create(workspaceId, input) {
    const doc = await InviteMongoModel.create({
      workspaceId,
      email: normalizeEmail(input.email),
      role: input.role,
      tokenHash: input.tokenHash,
      expiresAt: input.expiresAt,
      invitedBy: input.invitedBy,
    });
    return toInviteData(doc);
  },

  async listForWorkspace(workspaceId) {
    const docs = await InviteMongoModel.find({ workspaceId })
      .sort({ createdAt: -1 })
      .lean<InviteFields[]>();
    return docs.map(toInviteData);
  },

  async markAccepted(workspaceId, id, userId) {
    // Pending and unexpired in the same atomic update: an invite is accepted at most once. The
    // TTL monitor removes expired invites only every minute or so.
    const now = new Date();
    const doc = await InviteMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, status: 'pending', expiresAt: { $gt: now } },
      { $set: { status: 'accepted', acceptedBy: userId, acceptedAt: now } },
      { new: true },
    ).lean<InviteFields>();
    return doc ? toInviteData(doc) : null;
  },

  async revoke(workspaceId, id) {
    const result = await InviteMongoModel.updateOne(
      { _id: id, workspaceId, status: 'pending' },
      { $set: { status: 'revoked' } },
    );
    return result.modifiedCount > 0;
  },

  async findByTokenHash(tokenHash) {
    const doc = await InviteMongoModel.findOne({ tokenHash }).lean<InviteFields>();
    return doc ? toInviteData(doc) : null;
  },

  async listPendingForEmail(email) {
    const docs = await InviteMongoModel.find({
      email: normalizeEmail(email),
      status: 'pending',
      expiresAt: { $gt: new Date() },
    })
      .sort({ createdAt: -1 })
      .lean<InviteFields[]>();
    return docs.map(toInviteData);
  },
};
