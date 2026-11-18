import mongoose from 'mongoose';

import {
  ROUTING_QUOTA_TABLE_NAME,
  type IRoutingQuotaRepository,
} from '../definitions/RoutingQuota.js';
import { assertFieldKey } from './common.js';

interface RoutingQuotaFields {
  /** `<workspaceId>|<YYYY-MM-DD>` */
  _id: string;
  count: number;
  /**
   * Seconds, by trip and its ends (`from|to|mode|lat:lon|lat:lon`, place ids and 1e-5°): what was
   * fetched that day.
   */
  routes: Record<string, number>;
  expireAt: Date;
}

const schema = new mongoose.Schema<RoutingQuotaFields>(
  {
    _id: { type: String, required: true },
    count: { type: Number, required: true, default: 0 },
    routes: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, number> => ({}) },
    expireAt: { type: Date, required: true },
  },
  { collection: ROUTING_QUOTA_TABLE_NAME, minimize: false },
);

schema.index({ expireAt: 1 }, { expireAfterSeconds: 0 }); // TTL, two days after its day

export const RoutingQuotaMongoModel = mongoose.model<RoutingQuotaFields>('RoutingQuota', schema);

const DAY_MS = 24 * 60 * 60 * 1000;
const DAY_PATTERN = /^\d{4}-\d{2}-\d{2}$/;

function idOf(workspaceId: string, day: string): string {
  if (!DAY_PATTERN.test(day)) throw new Error('RoutingQuota: day must be YYYY-MM-DD');
  return `${workspaceId}|${day}`;
}

/** Two days after the day starts (UTC): past its end in every time zone. */
function expiryOf(day: string): Date {
  return new Date(new Date(`${day}T00:00:00.000Z`).getTime() + 2 * DAY_MS);
}

const escapeRegex = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

async function tryReserve(
  _id: string,
  day: string,
  limit: number,
): Promise<'reserved' | 'full' | 'raced'> {
  try {
    // The filter holds only while the count is under the limit; at the limit the upsert would
    // insert a second document with this `_id`, which is the duplicate key answered as "full".
    await RoutingQuotaMongoModel.updateOne(
      { _id, count: { $lt: limit } },
      { $inc: { count: 1 }, $setOnInsert: { routes: {}, expireAt: expiryOf(day) } },
      { upsert: true },
    );
    return 'reserved';
  } catch (error) {
    if ((error as { code?: unknown } | null)?.code === 11000) {
      const doc = await RoutingQuotaMongoModel.findById(_id).lean<RoutingQuotaFields>();
      return doc !== null && doc.count >= limit ? 'full' : 'raced';
    }
    throw error;
  }
}

export const RoutingQuotaRepository: IRoutingQuotaRepository = {
  async reserve(workspaceId, day, limit) {
    const _id = idOf(workspaceId, day);
    // Two first-ever reservations can race on the upsert: the loser retries once before "full".
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const outcome = await tryReserve(_id, day, limit);
      if (outcome !== 'raced') return outcome === 'reserved';
    }
    return false;
  },

  async cachedSeconds(workspaceId, day, tripKey) {
    assertFieldKey(tripKey);
    const doc = await RoutingQuotaMongoModel.findById(idOf(workspaceId, day), {
      [`routes.${tripKey}`]: 1,
    }).lean<{ routes?: Record<string, unknown> }>();
    const seconds = doc?.routes?.[tripKey];
    return typeof seconds === 'number' && Number.isFinite(seconds) ? seconds : null;
  },

  async rememberSeconds(workspaceId, day, tripKey, seconds) {
    assertFieldKey(tripKey);
    await RoutingQuotaMongoModel.updateOne(
      { _id: idOf(workspaceId, day) },
      {
        $set: { [`routes.${tripKey}`]: seconds },
        $setOnInsert: { count: 0, expireAt: expiryOf(day) },
      },
      { upsert: true },
    );
  },

  async deleteForWorkspace(workspaceId) {
    const result = await RoutingQuotaMongoModel.deleteMany({
      _id: { $regex: `^${escapeRegex(workspaceId)}\\|` },
    });
    return result.deletedCount;
  },
};
