import mongoose from 'mongoose';

import {
  CREATE_QUOTA_TABLE_NAME,
  type ICreateQuotaRepository,
} from '../definitions/CreateQuota.js';

interface CreateQuotaFields {
  /** `<userId>|<provider>|<hour start, epoch ms>` */
  _id: string;
  count: number;
  expireAt: Date;
}

const schema = new mongoose.Schema<CreateQuotaFields>(
  {
    _id: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    expireAt: { type: Date, required: true },
  },
  { collection: CREATE_QUOTA_TABLE_NAME },
);

schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 }); // TTL, after the hour

export const CreateQuotaMongoModel = mongoose.model<CreateQuotaFields>('CreateQuota', schema);

const HOUR_MS = 60 * 60 * 1000;
const keyOf = (userId: string, provider: string, hourStart: Date): string =>
  `${userId}|${provider}|${String(hourStart.getTime())}`;

async function tryReserve(
  _id: string,
  hourStart: Date,
  limit: number,
): Promise<'reserved' | 'full' | 'raced'> {
  try {
    // The filter holds only while the count is under the limit; at the limit the upsert would
    // insert a second document with this `_id`, which is the duplicate key answered as "full".
    await CreateQuotaMongoModel.updateOne(
      { _id, count: { $lt: limit } },
      {
        $inc: { count: 1 },
        $setOnInsert: { expireAt: new Date(hourStart.getTime() + 2 * HOUR_MS) },
      },
      { upsert: true },
    );
    return 'reserved' as const;
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 11000) {
      const doc = await CreateQuotaMongoModel.findById(_id).lean<CreateQuotaFields>();
      return doc !== null && doc.count >= limit ? ('full' as const) : ('raced' as const);
    }
    throw error;
  }
}

export const CreateQuotaRepository: ICreateQuotaRepository = {
  async reserve(userId, provider, hourStart, limit) {
    const _id = keyOf(userId, provider, hourStart);
    // Two first-ever reservations can race on the upsert: the loser retries once before "full".
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await tryReserve(_id, hourStart, limit);
      if (outcome !== 'raced') return outcome === 'reserved';
    }
    return false;
  },

  async release(userId, provider, hourStart) {
    await CreateQuotaMongoModel.updateOne(
      { _id: keyOf(userId, provider, hourStart), count: { $gt: 0 } },
      { $inc: { count: -1 } },
    );
  },
};
