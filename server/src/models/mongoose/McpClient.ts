import mongoose from 'mongoose';

import {
  MCP_CLIENT_TABLE_NAME,
  type IMcpClientRepository,
  type McpClientData,
} from '../definitions/McpClient.js';
import { uuidIdField } from './common.js';

interface McpClientFields {
  _id: string;
  clientName: string;
  redirectUris: string[];
  lastUsedAt: Date;
  createdAt: Date;
}

const mcpClientSchema = new mongoose.Schema<McpClientFields>(
  {
    _id: uuidIdField,
    clientName: { type: String, required: true },
    redirectUris: { type: [String], required: true },
    lastUsedAt: { type: Date, required: true, default: (): Date => new Date() },
  },
  { timestamps: { createdAt: true, updatedAt: false }, collection: MCP_CLIENT_TABLE_NAME },
);

// A client nobody has used for 30 days is dropped.
mcpClientSchema.index({ lastUsedAt: 1 }, { expireAfterSeconds: 30 * 86400 });

export const McpClientMongoModel = mongoose.model<McpClientFields>('McpClient', mcpClientSchema);

function toMcpClientData(doc: McpClientFields): McpClientData {
  return {
    id: doc._id,
    clientName: doc.clientName,
    redirectUris: [...doc.redirectUris],
    source: 'dcr',
    lastUsedAt: doc.lastUsedAt,
    createdAt: doc.createdAt,
  };
}

export const McpClientRepository: IMcpClientRepository = {
  async create(input) {
    const doc = await McpClientMongoModel.create({
      clientName: input.clientName,
      redirectUris: input.redirectUris,
      lastUsedAt: new Date(),
    });
    return toMcpClientData(doc);
  },

  async findById(id) {
    const doc = await McpClientMongoModel.findById(id).lean<McpClientFields>();
    return doc === null ? null : toMcpClientData(doc);
  },

  async touch(id, at) {
    await McpClientMongoModel.updateOne({ _id: id }, { $set: { lastUsedAt: at } });
  },
};
