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

type CalendarLinkFields = Omit<CalendarLinkData, 'id'> & { _id: string };

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
// hasOtherLive) and another integration's delete of it (findOthersDeleted) are point lookups, not
// a seek per integration.
calendarLinkSchema.index({ workspaceId: 1, calendarId: 1, googleEventId: 1 });

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
];

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
      { $set: { tombstonedAt: new Date(), deletedBy } },
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

  async removeForIntegration(workspaceId, integrationId) {
    const result = await CalendarLinkMongoModel.deleteMany({ workspaceId, integrationId });
    return result.deletedCount;
  },

  async findOthersDeleted(workspaceId, integrationId, key, since) {
    const doc = await CalendarLinkMongoModel.findOne({
      workspaceId,
      calendarId: key.calendarId,
      googleEventId: key.googleEventId,
      integrationId: { $ne: integrationId },
      deletedBy: 'dashboard',
      tombstonedAt: { $gte: since },
    }).lean<CalendarLinkFields>();
    return doc ? toCalendarLinkData(doc) : null;
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

  async release(workspaceId, id, calendarId) {
    const doc = await CalendarLinkMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, calendarId, deletedBy: 'dashboard', tombstonedAt: { $ne: null } },
      { $set: { tombstonedAt: null, deletedBy: null } },
      { new: true, runValidators: true },
    ).lean<CalendarLinkFields>();
    return doc ? toCalendarLinkData(doc) : null;
  },

  async remove(workspaceId, id) {
    const result = await CalendarLinkMongoModel.deleteOne({ _id: id, workspaceId });
    return result.deletedCount > 0;
  },
};
