import mongoose from 'mongoose';

import { AGENT_SCOPES, type AgentScope } from '../../types/domain.js';
import {
  MCP_AUTH_REQUEST_TABLE_NAME,
  type IMcpAuthRequestRepository,
  type McpAuthRequestData,
} from '../definitions/McpAuthRequest.js';
import { uuidIdField } from './common.js';

interface McpAuthRequestFields {
  _id: string;
  clientId: string;
  clientName: string;
  redirectUri: string;
  state: string | null;
  codeChallenge: string;
  resource: string;
  requestedScopes: string[];
  status: McpAuthRequestData['status'];
  userId: string | null;
  workspaceId: string | null;
  scopes: string[];
  name: string | null;
  codeHash: string | null;
  expiresAt: Date;
  createdAt: Date;
}

const mcpAuthRequestSchema = new mongoose.Schema<McpAuthRequestFields>(
  {
    _id: uuidIdField,
    clientId: { type: String, required: true },
    clientName: { type: String, required: true },
    redirectUri: { type: String, required: true },
    state: { type: String, default: null },
    codeChallenge: { type: String, required: true },
    resource: { type: String, required: true },
    requestedScopes: { type: [{ type: String, enum: AGENT_SCOPES }], default: [] },
    status: {
      type: String,
      enum: ['pending', 'approved', 'used', 'denied'],
      required: true,
      default: 'pending',
    },
    userId: { type: String, default: null },
    workspaceId: { type: String, default: null },
    scopes: { type: [{ type: String, enum: AGENT_SCOPES }], default: [] },
    name: { type: String, default: null },
    codeHash: { type: String, default: null },
    expiresAt: { type: Date, required: true },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: MCP_AUTH_REQUEST_TABLE_NAME },
);

// Gone when the request or its code expires.
mcpAuthRequestSchema.index({ expiresAt: 1 }, { expireAfterSeconds: 0 });
mcpAuthRequestSchema.index(
  { codeHash: 1 },
  { unique: true, partialFilterExpression: { codeHash: { $type: 'string' } } },
);

export const McpAuthRequestMongoModel = mongoose.model<McpAuthRequestFields>(
  'McpAuthRequest',
  mcpAuthRequestSchema,
);

function toData(doc: McpAuthRequestFields): McpAuthRequestData {
  return {
    id: doc._id,
    clientId: doc.clientId,
    clientName: doc.clientName,
    redirectUri: doc.redirectUri,
    state: doc.state,
    codeChallenge: doc.codeChallenge,
    resource: doc.resource,
    requestedScopes: doc.requestedScopes as AgentScope[],
    status: doc.status,
    userId: doc.userId,
    workspaceId: doc.workspaceId,
    scopes: doc.scopes as AgentScope[],
    name: doc.name,
    expiresAt: doc.expiresAt,
    createdAt: doc.createdAt,
  };
}

export const McpAuthRequestRepository: IMcpAuthRequestRepository = {
  async create(input) {
    return toData(await McpAuthRequestMongoModel.create(input));
  },

  async findById(id) {
    const doc = await McpAuthRequestMongoModel.findById(id).lean<McpAuthRequestFields>();
    return doc === null ? null : toData(doc);
  },

  async findByCodeHash(codeHash) {
    const doc = await McpAuthRequestMongoModel.findOne({ codeHash }).lean<McpAuthRequestFields>();
    return doc === null ? null : toData(doc);
  },

  async approve(id, input, now) {
    const doc = await McpAuthRequestMongoModel.findOneAndUpdate(
      { _id: id, status: 'pending', expiresAt: { $gt: now } },
      {
        $set: {
          status: 'approved',
          userId: input.userId,
          workspaceId: input.workspaceId,
          scopes: input.scopes,
          name: input.name,
          codeHash: input.codeHash,
          expiresAt: input.expiresAt,
        },
      },
      { new: true },
    ).lean<McpAuthRequestFields>();
    return doc === null ? null : toData(doc);
  },

  async deny(id) {
    const result = await McpAuthRequestMongoModel.updateOne(
      { _id: id, status: 'pending' },
      { $set: { status: 'denied' } },
    );
    return result.modifiedCount === 1;
  },

  async markUsed(id, expectedStatus) {
    const result = await McpAuthRequestMongoModel.updateOne(
      { _id: id, status: expectedStatus },
      { $set: { status: 'used' } },
    );
    return result.modifiedCount === 1;
  },
};
