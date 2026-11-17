import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

import { CALENDAR_LINK_DIRECTIONS } from '../../types/domain.js';
import {
  CALENDAR_LINK_TABLE_NAME,
  type CalendarLinkData,
  type CalendarLinkDeletedBy,
  type CalendarLinkPatch,
  type ICalendarLinkRepository,
} from '../definitions/CalendarLink.js';
import { setFields, uuidIdField } from './common.js';

/** `lastSweptAt` is the sweep's own bookkeeping (EventClaim): not part of CalendarLinkData. */
type CalendarLinkFields = Omit<CalendarLinkData, 'id'> & {
  _id: string;
  lastSweptAt?: Date | null;
};

const DELETED_BY: readonly CalendarLinkDeletedBy[] = ['google', 'dashboard', 'google_kept'];

const calendarLinkSchema = new mongoose.Schema<CalendarLinkFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    integrationId: { type: String, required: true },
    calendarId: { type: String, required: true },
    googleEventId: { type: String, required: true },
    itemId: { type: String, required: true },
    direction: { type: String, enum: CALENDAR_LINK_DIRECTIONS, required: true },
    lastEtag: { type: String, default: null },
    lastGoogleUpdated: { type: Date, default: null },
    lastItemUpdatedAt: { type: Date, default: null },
    pushedHash: { type: String, default: null },
    tombstonedAt: { type: Date, default: null },
    deletedBy: { type: String, enum: DELETED_BY, default: null },
    deleteAnsweredAt: { type: Date, default: null },
    lastSweptAt: { type: Date, default: null },
  },
  { timestamps: true, collection: CALENDAR_LINK_TABLE_NAME },
);

calendarLinkSchema.index({ integrationId: 1, calendarId: 1, googleEventId: 1 }, { unique: true });
calendarLinkSchema.index({ integrationId: 1, itemId: 1 }, { unique: true });
calendarLinkSchema.index(
  { integrationId: 1, tombstonedAt: 1 },
  { partialFilterExpression: { tombstonedAt: null } },
); // live links for diffing
// One event across the workspace's integrations: one tracker per event (removeOthersForEvent,
// hasOtherLive) and another integration's claim on it (findOthersStanding) are point lookups, not
// a seek per integration.
calendarLinkSchema.index({ workspaceId: 1, calendarId: 1, googleEventId: 1 });
// The sweep's query (listUnsettledClaims): an integration's unanswered claims (an explicit null),
// the least recently swept first, then the oldest. Partial, so it holds only the few claims
// standing at any time, and "is any claim stuck?" is an index seek, not a scan of the links.
calendarLinkSchema.index(
  { integrationId: 1, lastSweptAt: 1, tombstonedAt: 1 },
  { partialFilterExpression: { deletedBy: 'dashboard', deleteAnsweredAt: { $type: 'null' } } },
);

export const CalendarLinkMongoModel = mongoose.model<CalendarLinkFields>(
  'CalendarLink',
  calendarLinkSchema,
);

const PATCH_KEYS: readonly (keyof CalendarLinkPatch)[] = [
  'itemId',
  'direction',
  'lastEtag',
  'lastGoogleUpdated',
  'lastItemUpdatedAt',
  'pushedHash',
  'tombstonedAt',
  'deletedBy',
  'deleteAnsweredAt',
];

/**
 * When the claim's DELETE was answered. A `dashboard` tombstone stored before the field existed
 * (the field missing, not null) was written by the old code after Google answered: at its
 * `tombstonedAt`.
 */
function answeredAtOf(doc: CalendarLinkFields): Date | null {
  const stored = (doc as { deleteAnsweredAt?: Date | null }).deleteAnsweredAt;
  if (stored !== undefined) return stored;
  return doc.deletedBy === 'dashboard' ? (doc.tombstonedAt ?? null) : null;
}

function toCalendarLinkData(doc: CalendarLinkFields): CalendarLinkData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    integrationId: doc.integrationId,
    calendarId: doc.calendarId,
    googleEventId: doc.googleEventId,
    itemId: doc.itemId,
    direction: doc.direction,
    lastEtag: doc.lastEtag ?? null,
    lastGoogleUpdated: doc.lastGoogleUpdated ?? null,
    lastItemUpdatedAt: doc.lastItemUpdatedAt ?? null,
    pushedHash: doc.pushedHash ?? null,
    tombstonedAt: doc.tombstonedAt ?? null,
    deletedBy: doc.deletedBy ?? null,
    deleteAnsweredAt: answeredAtOf(doc),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const CalendarLinkRepository: ICalendarLinkRepository = {
  async upsert(workspaceId, integrationId, key, patch) {
    // One link per item and integration (the unique index): found by its item, so a link whose
    // event moved to another calendar keeps its row instead of colliding with it.
    const doc = await CalendarLinkMongoModel.findOneAndUpdate(
      { workspaceId, integrationId, itemId: patch.itemId },
      {
        $set: {
          ...setFields(patch, PATCH_KEYS),
          calendarId: key.calendarId,
          googleEventId: key.googleEventId,
        },
        $setOnInsert: { _id: randomUUID() },
      },
      { upsert: true, new: true, runValidators: true },
    ).lean<CalendarLinkFields>();
    return toCalendarLinkData(doc);
  },

  async findByItem(workspaceId, integrationId, itemId) {
    const doc = await CalendarLinkMongoModel.findOne({
      workspaceId,
      integrationId,
      itemId,
    }).lean<CalendarLinkFields>();
    return doc ? toCalendarLinkData(doc) : null;
  },

  async listLive(workspaceId, integrationId) {
    const docs = await CalendarLinkMongoModel.find({
      workspaceId,
      integrationId,
      tombstonedAt: null,
    }).lean<CalendarLinkFields[]>();
    return docs.map(toCalendarLinkData);
  },

  async listLiveForItem(workspaceId, itemId) {
    const docs = await CalendarLinkMongoModel.find({
      workspaceId,
      itemId,
      tombstonedAt: null,
    }).lean<CalendarLinkFields[]>();
    return docs.map(toCalendarLinkData);
  },

  async listKeptStops(workspaceId, integrationId) {
    const docs = await CalendarLinkMongoModel.find({
      workspaceId,
      integrationId,
      tombstonedAt: { $ne: null },
      deletedBy: 'google_kept',
    }).lean<CalendarLinkFields[]>();
    return docs.map(toCalendarLinkData);
  },

  async listTombstonedSince(workspaceId, integrationId, since) {
    const docs = await CalendarLinkMongoModel.find({
      workspaceId,
      integrationId,
      tombstonedAt: { $gt: since },
    }).lean<CalendarLinkFields[]>();
    return docs.map(toCalendarLinkData);
  },

  async findByEvent(workspaceId, integrationId, key) {
    const doc = await CalendarLinkMongoModel.findOne({
      workspaceId,
      integrationId,
      calendarId: key.calendarId,
      googleEventId: key.googleEventId,
    }).lean<CalendarLinkFields>();
    return doc ? toCalendarLinkData(doc) : null;
  },

  async tombstone(workspaceId, id, deletedBy, calendarId) {
    // Live links only: the first tombstone keeps its time (the 30-day retention runs from it).
    const doc = await CalendarLinkMongoModel.findOneAndUpdate(
      {
        _id: id,
        workspaceId,
        tombstonedAt: null,
        ...(calendarId === undefined ? {} : { calendarId }),
      },
      { $set: { tombstonedAt: new Date(), deletedBy, deleteAnsweredAt: null, lastSweptAt: null } },
      { new: true, runValidators: true },
    ).lean<CalendarLinkFields>();
    return doc ? toCalendarLinkData(doc) : null;
  },

  async removeOthersForEvent(workspaceId, integrationId, key) {
    const result = await CalendarLinkMongoModel.deleteMany({
      workspaceId,
      integrationId: { $ne: integrationId },
      calendarId: key.calendarId,
      googleEventId: key.googleEventId,
      tombstonedAt: null,
    });
    return result.deletedCount;
  },

  async removeForIntegration(workspaceId, integrationId, keepClaimsSince) {
    const result = await CalendarLinkMongoModel.deleteMany({
      workspaceId,
      integrationId,
      ...(keepClaimsSince === undefined
        ? {}
        : {
            // Not a claim that may still stand: answered since then, or (unanswered or stored
            // before the field existed) claimed since then.
            $nor: [
              { deletedBy: 'dashboard', deleteAnsweredAt: { $gte: keepClaimsSince } },
              {
                deletedBy: 'dashboard',
                deleteAnsweredAt: null,
                tombstonedAt: { $gte: keepClaimsSince },
              },
            ],
          }),
    });
    return result.deletedCount;
  },

  async findOthersStanding(workspaceId, integrationId, key, since) {
    const doc = await CalendarLinkMongoModel.findOne({
      workspaceId,
      calendarId: key.calendarId,
      googleEventId: key.googleEventId,
      integrationId: { $ne: integrationId },
      deletedBy: 'dashboard',
      tombstonedAt: { $ne: null },
      $or: [
        { deleteAnsweredAt: { $gte: since.answeredSince } },
        // Unanswered: an explicit null (a missing field: an old claim, answered at its tombstone).
        { deleteAnsweredAt: { $type: 'null' }, tombstonedAt: { $gte: since.claimedSince } },
        { deleteAnsweredAt: { $exists: false }, tombstonedAt: { $gte: since.answeredSince } },
      ],
    }).lean<CalendarLinkFields>();
    return doc ? toCalendarLinkData(doc) : null;
  },

  async settle(workspaceId, id, tombstonedAt) {
    const result = await CalendarLinkMongoModel.updateOne(
      {
        _id: id,
        workspaceId,
        deletedBy: 'dashboard',
        tombstonedAt,
        deleteAnsweredAt: { $type: 'null' },
      },
      { $set: { deleteAnsweredAt: new Date() } },
    );
    return result.modifiedCount > 0;
  },

  async listUnsettledClaims(workspaceId, integrationId, before, limit) {
    const docs = await CalendarLinkMongoModel.find({
      workspaceId,
      integrationId,
      deletedBy: 'dashboard',
      // An explicit null only: a row stored before the field existed was answered.
      deleteAnsweredAt: { $type: 'null' },
      tombstonedAt: { $ne: null, $lt: before },
    })
      // Never swept first (null sorts first, a missing field too), then the longest ago, then the
      // oldest claim: a claim whose read always fails goes to the back of the line.
      .sort({ lastSweptAt: 1, tombstonedAt: 1 })
      .limit(limit)
      .lean<CalendarLinkFields[]>();
    return docs.map(toCalendarLinkData);
  },

  async markSwept(workspaceId, id, tombstonedAt) {
    await CalendarLinkMongoModel.updateOne(
      {
        _id: id,
        workspaceId,
        deletedBy: 'dashboard',
        tombstonedAt,
        deleteAnsweredAt: { $type: 'null' },
      },
      { $set: { lastSweptAt: new Date() } },
    );
  },

  async hasOtherLive(workspaceId, integrationId, key) {
    const found = await CalendarLinkMongoModel.exists({
      workspaceId,
      calendarId: key.calendarId,
      googleEventId: key.googleEventId,
      integrationId: { $ne: integrationId },
      tombstonedAt: null,
    });
    return found !== null;
  },

  async release(workspaceId, id, calendarId, tombstonedAt) {
    const doc = await CalendarLinkMongoModel.findOneAndUpdate(
      {
        _id: id,
        workspaceId,
        calendarId,
        deletedBy: 'dashboard',
        tombstonedAt,
        // Never a settled claim: its delete was made or refused for good.
        deleteAnsweredAt: { $type: 'null' },
      },
      { $set: { tombstonedAt: null, deletedBy: null, deleteAnsweredAt: null, lastSweptAt: null } },
      { new: true, runValidators: true },
    ).lean<CalendarLinkFields>();
    return doc ? toCalendarLinkData(doc) : null;
  },

  async remove(workspaceId, id) {
    const result = await CalendarLinkMongoModel.deleteOne({ _id: id, workspaceId });
    return result.deletedCount > 0;
  },
};
