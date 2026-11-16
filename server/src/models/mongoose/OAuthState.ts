import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

import { PROVIDERS } from '../../types/domain.js';
import {
  OAUTH_STATE_TABLE_NAME,
  OAUTH_STATE_TTL_MS,
  type IOAuthStateRepository,
  type OAuthStateData,
} from '../definitions/OAuthState.js';

interface OAuthStateFields {
  _id: string;
  stateHash: string;
  browserHash: string;
  codeVerifier: string;
  userId: string;
  workspaceId: string;
  provider: string;
  integrationId: string | null;
  lng: string;
  createdAt: Date;
  usedAt: Date | null;
}

const oauthStateSchema = new mongoose.Schema<OAuthStateFields>(
  {
    _id: { type: String, default: (): string => randomUUID() },
    stateHash: { type: String, required: true },
    browserHash: { type: String, required: true },
    codeVerifier: { type: String, required: true },
    userId: { type: String, required: true },
    workspaceId: { type: String, required: true },
    provider: { type: String, enum: PROVIDERS, required: true },
    integrationId: { type: String, default: null },
    lng: { type: String, required: true },
    createdAt: { type: Date, required: true },
    usedAt: { type: Date, default: null },
  },
  { collection: OAUTH_STATE_TABLE_NAME },
);

oauthStateSchema.index({ stateHash: 1 }, { unique: true });
oauthStateSchema.index({ createdAt: 1 }, { expireAfterSeconds: OAUTH_STATE_TTL_MS / 1000 });

export const OAuthStateMongoModel = mongoose.model<OAuthStateFields>(
  'OAuthState',
  oauthStateSchema,
);

function toData(doc: OAuthStateFields): OAuthStateData {
  return {
    id: doc._id,
    stateHash: doc.stateHash,
    browserHash: doc.browserHash,
    codeVerifier: doc.codeVerifier,
    userId: doc.userId,
    workspaceId: doc.workspaceId,
    provider: doc.provider as OAuthStateData['provider'],
    integrationId: doc.integrationId,
    lng: doc.lng,
    createdAt: doc.createdAt,
    usedAt: doc.usedAt,
  };
}

export const OAuthStateRepository: IOAuthStateRepository = {
  async create(workspaceId, input) {
    const doc = await OAuthStateMongoModel.create({ ...input, workspaceId, usedAt: null });
    return toData(doc.toObject());
  },

  async findByStateHash(stateHash) {
    const doc = await OAuthStateMongoModel.findOne({ stateHash }).lean<OAuthStateFields>();
    return doc === null ? null : toData(doc);
  },

  async claim(workspaceId, id, at) {
    const claimed = await OAuthStateMongoModel.updateOne(
      { _id: id, workspaceId, usedAt: null },
      { $set: { usedAt: at } },
    );
    return claimed.modifiedCount === 1;
  },
};
