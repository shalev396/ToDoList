import mongoose from 'mongoose';

import { AGENT_SCOPES } from '../../types/domain.js';
import {
  AGENT_KEY_TABLE_NAME,
  type AgentKeyData,
  type IAgentKeyRepository,
} from '../definitions/AgentKey.js';
import { setFields, uuidIdField } from './common.js';

type AgentKeyFields = Omit<AgentKeyData, 'id'> & { _id: string; keyHash: string };

const agentKeySchema = new mongoose.Schema<AgentKeyFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    name: { type: String, required: true },
    keyHash: { type: String, required: true },
    prefix: { type: String, required: true },
    scopes: { type: [{ type: String, enum: AGENT_SCOPES }], default: [] },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: AGENT_KEY_TABLE_NAME },
);

agentKeySchema.index({ keyHash: 1 }, { unique: true }); // lookup on every MCP call
agentKeySchema.index({ workspaceId: 1, userId: 1, revokedAt: 1 });
// Expiry reminders. No TTL: keys are kept for the audit trail.
agentKeySchema.index(
  { expiresAt: 1 },
  { partialFilterExpression: { expiresAt: { $type: 'date' } } },
);

export const AgentKeyMongoModel = mongoose.model<AgentKeyFields>('AgentKey', agentKeySchema);

/** Everything but the key hash, which never leaves the repository. */
function toAgentKeyData(doc: AgentKeyFields): AgentKeyData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    userId: doc.userId,
    name: doc.name,
    prefix: doc.prefix,
    scopes: [...doc.scopes],
    expiresAt: doc.expiresAt ?? null,
    lastUsedAt: doc.lastUsedAt ?? null,
    revokedAt: doc.revokedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const AgentKeyRepository: IAgentKeyRepository = {
  async create(workspaceId, input) {
    const doc = await AgentKeyMongoModel.create({
      workspaceId,
      userId: input.userId,
      name: input.name,
      keyHash: input.keyHash,
      prefix: input.prefix,
      scopes: input.scopes,
      ...setFields(input, ['expiresAt']),
    });
    return toAgentKeyData(doc);
  },

  async listForUser(workspaceId, userId) {
    const docs = await AgentKeyMongoModel.find({ workspaceId, userId, revokedAt: null })
      .sort({ createdAt: -1 })
      .lean<AgentKeyFields[]>();
    return docs.map(toAgentKeyData);
  },

  async findById(workspaceId, id) {
    const doc = await AgentKeyMongoModel.findOne({ _id: id, workspaceId }).lean<AgentKeyFields>();
    return doc ? toAgentKeyData(doc) : null;
  },

  async listForWorkspace(workspaceId, userId) {
    const filter = userId === null ? { workspaceId } : { workspaceId, userId };
    const docs = await AgentKeyMongoModel.find(filter)
      .sort({ createdAt: -1 })
      .lean<AgentKeyFields[]>();
    return docs.map(toAgentKeyData);
  },

  async revoke(workspaceId, id) {
    const result = await AgentKeyMongoModel.updateOne(
      { _id: id, workspaceId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  },

  async revokeForUser(workspaceId, userId) {
    const result = await AgentKeyMongoModel.updateMany(
      { workspaceId, userId, revokedAt: null },
      { $set: { revokedAt: new Date() } },
    );
    return result.modifiedCount;
  },

  async touch(workspaceId, id, at) {
    // Runs on every MCP call: a use is not an edit, so updatedAt stays.
    await AgentKeyMongoModel.updateOne(
      { _id: id, workspaceId },
      { $set: { lastUsedAt: at } },
      { timestamps: false },
    );
  },

  async countForUser(workspaceId, userId) {
    return AgentKeyMongoModel.countDocuments({ workspaceId, userId, revokedAt: null });
  },

  async findByHash(keyHash) {
    const doc = await AgentKeyMongoModel.findOne({ keyHash }).lean<AgentKeyFields>();
    return doc ? toAgentKeyData(doc) : null;
  },
};
