import mongoose from 'mongoose';

import type { TravelSettings } from '../../types/travel.js';
import {
  GEOCODES_MAX,
  TRAVEL_PROFILE_TABLE_NAME,
  type ITravelProfileRepository,
  type StoredLatLon,
  type TravelProfileData,
} from '../definitions/TravelProfile.js';
import { assertFieldKey } from './common.js';

type TravelProfileFields = Omit<TravelProfileData, 'id'> & { _id: string };

const travelProfileSchema = new mongoose.Schema<TravelProfileFields>(
  {
    // `<workspaceId>|<userId>`: one profile per member.
    _id: { type: String, required: true },
    workspaceId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    settings: { type: mongoose.Schema.Types.Mixed, required: true },
    remembered: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, number> => ({}) },
    geocodes: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, unknown> => ({}) },
    itemPlaces: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, string> => ({}) },
    containerPlaces: {
      type: mongoose.Schema.Types.Mixed,
      default: (): Record<string, string> => ({}),
    },
    hasTravel: { type: Boolean, default: false },
    lastPassDay: { type: String, default: null },
    updatedAt: { type: Date, default: (): Date => new Date() },
  },
  // Every write sets `updatedAt` itself; minimize: false keeps the empty maps as {}.
  { collection: TRAVEL_PROFILE_TABLE_NAME, minimize: false },
);

travelProfileSchema.index({ workspaceId: 1 }); // a workspace's deletion
// The daily pass: the members with travel only.
travelProfileSchema.index({ hasTravel: 1 }, { partialFilterExpression: { hasTravel: true } });

export const TravelProfileMongoModel = mongoose.model<TravelProfileFields>(
  'TravelProfile',
  travelProfileSchema,
);

const idOf = (workspaceId: string, ownerUserId: string): string => `${workspaceId}|${ownerUserId}`;

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** A plain copy of a stored map (a missing one is empty). */
function mapOf<T>(stored: Record<string, T> | undefined | null): Record<string, T> {
  return { ...(stored ?? {}) };
}

function toTravelProfileData(doc: TravelProfileFields): TravelProfileData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    ownerUserId: doc.ownerUserId,
    settings: doc.settings,
    remembered: mapOf(doc.remembered),
    geocodes: mapOf(doc.geocodes),
    itemPlaces: mapOf(doc.itemPlaces),
    containerPlaces: mapOf(doc.containerPlaces),
    hasTravel: doc.hasTravel,
    lastPassDay: doc.lastPassDay ?? null,
    updatedAt: doc.updatedAt,
  };
}

/** The member's profile only: its id, workspace and owner all match. */
const ownFilter = (workspaceId: string, ownerUserId: string): Record<string, unknown> => ({
  _id: idOf(workspaceId, ownerUserId),
  workspaceId,
  ownerUserId,
});

/** One write on the member's profile; the profile as now stored (null when there is none). */
async function change(
  workspaceId: string,
  ownerUserId: string,
  update: Record<string, unknown>,
): Promise<TravelProfileData | null> {
  const doc = await TravelProfileMongoModel.findOneAndUpdate(
    ownFilter(workspaceId, ownerUserId),
    update,
    { new: true },
  ).lean<TravelProfileFields>();
  return doc ? toTravelProfileData(doc) : null;
}

/** A map's entries without the ones `keep` (an aggregation expression on `$$this`) refuses. */
function filteredMap(field: string, keep: Record<string, unknown>): Record<string, unknown> {
  return {
    $arrayToObject: {
      $filter: { input: { $objectToArray: { $ifNull: [`$${field}`, {}] } }, cond: keep },
    },
  };
}

export const TravelProfileRepository: ITravelProfileRepository = {
  async findOrCreate(workspaceId, ownerUserId, defaults) {
    // Two first reads can race on the upsert: the loser reads the winner's profile.
    for (let attempt = 0; ; attempt += 1) {
      try {
        const doc = await TravelProfileMongoModel.findOneAndUpdate(
          ownFilter(workspaceId, ownerUserId),
          {
            $setOnInsert: {
              settings: defaults.settings,
              remembered: {},
              geocodes: {},
              itemPlaces: {},
              containerPlaces: {},
              hasTravel: false,
              lastPassDay: null,
              updatedAt: new Date(),
            },
          },
          { upsert: true, new: true },
        ).lean<TravelProfileFields>();
        return toTravelProfileData(doc);
      } catch (error) {
        if (attempt > 0 || !isDuplicateKey(error)) throw error;
      }
    }
  },

  async setSettings(workspaceId, ownerUserId, settings: TravelSettings) {
    return change(workspaceId, ownerUserId, { $set: { settings, updatedAt: new Date() } });
  },

  async setRemembered(workspaceId, ownerUserId, tripKey, minutes) {
    assertFieldKey(tripKey);
    return change(workspaceId, ownerUserId, {
      $set: { [`remembered.${tripKey}`]: minutes, updatedAt: new Date() },
    });
  },

  async setPin(workspaceId, ownerUserId, map, id, placeId) {
    assertFieldKey(id);
    const path = `${map}.${id}`;
    return change(
      workspaceId,
      ownerUserId,
      placeId === null
        ? { $unset: { [path]: '' }, $set: { updatedAt: new Date() } }
        : { $set: { [path]: placeId, updatedAt: new Date() } },
    );
  },

  async storeGeocode(workspaceId, ownerUserId, hash, point: StoredLatLon | null) {
    assertFieldKey(hash);
    // One pipeline write: merged in (an existing key keeps its place), then the newest
    // GEOCODES_MAX kept, so parallel writes can't leave more.
    await TravelProfileMongoModel.updateOne(ownFilter(workspaceId, ownerUserId), [
      {
        $set: {
          geocodes: {
            $arrayToObject: {
              $slice: [
                {
                  $objectToArray: {
                    $mergeObjects: [
                      { $ifNull: ['$geocodes', {}] },
                      { $literal: { [hash]: point } },
                    ],
                  },
                },
                -GEOCODES_MAX,
              ],
            },
          },
          updatedAt: '$$NOW',
        },
      },
    ]);
  },

  async setLastPassDay(workspaceId, ownerUserId, day) {
    await TravelProfileMongoModel.updateOne(ownFilter(workspaceId, ownerUserId), {
      $set: { lastPassDay: day, updatedAt: new Date() },
    });
  },

  async setHasTravel(workspaceId, ownerUserId, hasTravel) {
    await TravelProfileMongoModel.updateOne(ownFilter(workspaceId, ownerUserId), {
      $set: { hasTravel, updatedAt: new Date() },
    });
  },

  async forgetPlace(workspaceId, ownerUserId, placeId) {
    const place = { $literal: placeId };
    await TravelProfileMongoModel.updateOne(ownFilter(workspaceId, ownerUserId), [
      {
        $set: {
          itemPlaces: filteredMap('itemPlaces', { $ne: ['$$this.v', place] }),
          containerPlaces: filteredMap('containerPlaces', { $ne: ['$$this.v', place] }),
          // A trip key is `from|to|mode`: the trips from or to the place go.
          remembered: filteredMap('remembered', {
            $not: [{ $in: [place, { $split: ['$$this.k', '|'] }] }],
          }),
          updatedAt: '$$NOW',
        },
      },
    ]);
  },

  async delete(workspaceId, ownerUserId) {
    const result = await TravelProfileMongoModel.deleteOne(ownFilter(workspaceId, ownerUserId));
    return result.deletedCount > 0;
  },

  async deleteForWorkspace(workspaceId) {
    const result = await TravelProfileMongoModel.deleteMany({ workspaceId });
    return result.deletedCount;
  },

  // Global on purpose: the daily travel pass runs over every workspace.
  async listWithTravel() {
    const docs = await TravelProfileMongoModel.find(
      { hasTravel: true },
      { workspaceId: 1, ownerUserId: 1, lastPassDay: 1 },
    )
      .sort({ _id: 1 })
      .lean<Pick<TravelProfileFields, 'workspaceId' | 'ownerUserId' | 'lastPassDay'>[]>();
    return docs.map((doc) => ({
      workspaceId: doc.workspaceId,
      userId: doc.ownerUserId,
      lastPassDay: doc.lastPassDay ?? null,
    }));
  },
};
