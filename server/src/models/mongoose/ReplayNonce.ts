import mongoose from 'mongoose';

import {
  REPLAY_NONCE_TABLE_NAME,
  type IReplayNonceRepository,
} from '../definitions/ReplayNonce.js';

interface ReplayNonceFields {
  /** The nonce itself: `_id` makes it unique for free. */
  _id: string;
  workspaceId: string;
  integrationId: string;
  expireAt: Date;
}

const replayNonceSchema = new mongoose.Schema<ReplayNonceFields>(
  {
    _id: { type: String, required: true },
    workspaceId: { type: String, required: true },
    integrationId: { type: String, required: true },
    expireAt: { type: Date, required: true },
  },
  { collection: REPLAY_NONCE_TABLE_NAME },
);

replayNonceSchema.index({ expireAt: 1 }, { expireAfterSeconds: 0 }); // TTL, 10 minutes

export const ReplayNonceMongoModel = mongoose.model<ReplayNonceFields>(
  'ReplayNonce',
  replayNonceSchema,
);

/** MongoDB's duplicate key error. */
function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

export const ReplayNonceRepository: IReplayNonceRepository = {
  async insert(workspaceId, integrationId, nonce, expireAt) {
    try {
      await ReplayNonceMongoModel.create({ _id: nonce, workspaceId, integrationId, expireAt });
      return true;
    } catch (error) {
      if (isDuplicateKey(error)) return false; // a replay
      throw error;
    }
  },
};
