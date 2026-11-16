import mongoose from 'mongoose';

import { AGENT_SCOPES } from '../../types/domain.js';
import {
  AGENT_KEY_TABLE_NAME,
  type AgentKeyData,
  type IAgentKeyRepository,
} from '../definitions/AgentKey.js';
import { setFields, uuidIdField } from './common.js';

/**
 * Repository-only fields: no hash is mapped into AgentKeyData. (`findByRefreshHash` hands the
 * class the current refresh hash, which a rotation needs; the others stay here.)
 */
type AgentKeyFields = Omit<AgentKeyData, 'id' | 'kind'> & {
  _id: string;
  /** Absent on rows from before grants: those are keys. */
  kind?: AgentKeyData['kind'];
  keyHash: string;
  refreshHash?: string;
  prevRefreshHash?: string;
  prevRotatedAt?: Date;
  altRefreshHash?: string;
  refreshAuditedAt?: Date;
  sourceRequestId?: string;
};

/** A grant has no key prefix to show; its tokens begin with this. */
const GRANT_PREFIX = 'elo_';

const agentKeySchema = new mongoose.Schema<AgentKeyFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    userId: { type: String, required: true },
    name: { type: String, required: true },
    keyHash: { type: String, required: true },
    prefix: { type: String, required: true },
    scopes: { type: [{ type: String, enum: AGENT_SCOPES }], default: [] },
    kind: { type: String, enum: ['key', 'oauth'], default: 'key' },
    clientId: { type: String, default: null },
    clientName: { type: String, default: null },
    resource: { type: String, default: null },
    accessExpiresAt: { type: Date, default: null },
    refreshExpiresAt: { type: Date, default: null },
    refreshHash: { type: String },
    prevRefreshHash: { type: String },
    prevRotatedAt: { type: Date },
    altRefreshHash: { type: String },
    refreshAuditedAt: { type: Date },
    sourceRequestId: { type: String },
    expiresAt: { type: Date, default: null },
    lastUsedAt: { type: Date, default: null },
    revokedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: AGENT_KEY_TABLE_NAME },
);

agentKeySchema.index({ keyHash: 1 }, { unique: true }); // lookup on every MCP call
agentKeySchema.index({ refreshHash: 1 }, { unique: true, sparse: true }); // a refresh lookup
agentKeySchema.index({ prevRefreshHash: 1 }, { sparse: true }); // a retried refresh
agentKeySchema.index({ altRefreshHash: 1 }, { sparse: true }); // a doubled refresh's other token
agentKeySchema.index({ sourceRequestId: 1 }, { sparse: true }); // revoking a grant by its request
agentKeySchema.index({ workspaceId: 1, userId: 1, revokedAt: 1 });
// Expiry reminders. No TTL: keys are kept for the audit trail.
agentKeySchema.index(
  { expiresAt: 1 },
  { partialFilterExpression: { expiresAt: { $type: 'date' } } },
);

export const AgentKeyMongoModel = mongoose.model<AgentKeyFields>('AgentKey', agentKeySchema);

/** Everything but the hashes. Rows from before grants are keys. */
function toAgentKeyData(doc: AgentKeyFields): AgentKeyData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    userId: doc.userId,
    name: doc.name,
    prefix: doc.prefix,
    scopes: [...doc.scopes],
    kind: doc.kind ?? 'key',
    clientId: doc.clientId ?? null,
    clientName: doc.clientName ?? null,
    resource: doc.resource ?? null,
    accessExpiresAt: doc.accessExpiresAt ?? null,
    refreshExpiresAt: doc.refreshExpiresAt ?? null,
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
    const now = new Date();
    return AgentKeyMongoModel.countDocuments({
      workspaceId,
      userId,
      revokedAt: null,
      $and: [
        { $or: [{ expiresAt: null }, { expiresAt: { $gt: now } }] },
        // A grant whose refresh token ran out can never be used again.
        { $or: [{ refreshExpiresAt: null }, { refreshExpiresAt: { $gt: now } }] },
      ],
    });
  },

  async findByHash(keyHash) {
    const doc = await AgentKeyMongoModel.findOne({ keyHash }).lean<AgentKeyFields>();
    return doc ? toAgentKeyData(doc) : null;
  },

  async createGrant(workspaceId, input) {
    const doc = await AgentKeyMongoModel.create({
      workspaceId,
      userId: input.userId,
      name: input.name,
      keyHash: input.keyHash,
      prefix: GRANT_PREFIX,
      scopes: input.scopes,
      kind: 'oauth',
      clientId: input.clientId,
      clientName: input.clientName,
      resource: input.resource,
      accessExpiresAt: input.accessExpiresAt,
      refreshHash: input.refreshHash,
      refreshExpiresAt: input.refreshExpiresAt,
      expiresAt: input.expiresAt,
      sourceRequestId: input.sourceRequestId,
    });
    return toAgentKeyData(doc);
  },

  async findByRefreshHash(hash) {
    const doc = await AgentKeyMongoModel.findOne({
      $or: [{ refreshHash: hash }, { prevRefreshHash: hash }, { altRefreshHash: hash }],
    }).lean<AgentKeyFields>();
    if (doc?.refreshHash === undefined) return null;
    return {
      key: toAgentKeyData(doc),
      match:
        doc.refreshHash === hash
          ? 'current'
          : doc.altRefreshHash === hash
            ? 'alternate'
            : 'previous',
      prevRotatedAt: doc.prevRotatedAt ?? null,
      currentRefreshHash: doc.refreshHash,
      refreshAuditedAt: doc.refreshAuditedAt ?? null,
    };
  },

  async rotateGrant(id, expectedRefreshHash, next) {
    // One conditional update: only the caller that still holds the current refresh hash wins.
    const result = await AgentKeyMongoModel.updateOne(
      { _id: id, refreshHash: expectedRefreshHash, revokedAt: null },
      {
        $set: {
          keyHash: next.keyHash,
          accessExpiresAt: next.accessExpiresAt,
          refreshHash: next.refreshHash,
          refreshExpiresAt: next.refreshExpiresAt,
          prevRefreshHash: next.prevRefreshHash,
          prevRotatedAt: next.prevRotatedAt,
          ...(next.altRefreshHash === null ? {} : { altRefreshHash: next.altRefreshHash }),
          ...(next.refreshAuditedAt === undefined
            ? {}
            : { refreshAuditedAt: next.refreshAuditedAt }),
        },
        ...(next.altRefreshHash === null ? { $unset: { altRefreshHash: '' } } : {}),
      },
    );
    return result.modifiedCount > 0;
  },

  async findBySourceRequest(requestId) {
    const doc = await AgentKeyMongoModel.findOne({
      sourceRequestId: requestId,
    }).lean<AgentKeyFields>();
    return doc ? toAgentKeyData(doc) : null;
  },
};
