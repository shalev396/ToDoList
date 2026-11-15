import mongoose from 'mongoose';

import {
  DASHBOARD_VERSION_TABLE_NAME,
  type DashboardVersionData,
  type IDashboardVersionRepository,
} from '../definitions/DashboardVersion.js';
import { setFields, uuidIdField } from './common.js';

type DashboardVersionFields = Omit<DashboardVersionData, 'id'> & { _id: string };

const { Mixed } = mongoose.Schema.Types;

// No timestamps: `at` is the write's time, and versions never change.
const dashboardVersionSchema = new mongoose.Schema<DashboardVersionFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    dashboardId: { type: String, required: true },
    version: { type: Number, required: true },
    patch: { type: [Mixed], default: [] },
    inverse: { type: [Mixed], default: [] },
    snapshot: { type: Mixed, default: null },
    actorUserId: { type: String, required: true },
    actorAgentId: { type: String, default: null },
    summary: { type: String, default: null },
    at: { type: Date, default: (): Date => new Date() },
  },
  // minimize: false keeps empty objects ({} vars in a snapshot, `"value": {}` in a patch): without
  // it a stored version no longer replays to the state it was made from.
  { collection: DASHBOARD_VERSION_TABLE_NAME, minimize: false },
);

dashboardVersionSchema.index({ dashboardId: 1, version: -1 }, { unique: true });
dashboardVersionSchema.index({ workspaceId: 1, at: -1 });

export const DashboardVersionMongoModel = mongoose.model<DashboardVersionFields>(
  'DashboardVersion',
  dashboardVersionSchema,
);

function toDashboardVersionData(doc: DashboardVersionFields): DashboardVersionData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    dashboardId: doc.dashboardId,
    version: doc.version,
    patch: [...doc.patch],
    inverse: [...doc.inverse],
    snapshot: doc.snapshot ?? null,
    actorUserId: doc.actorUserId,
    actorAgentId: doc.actorAgentId ?? null,
    summary: doc.summary ?? null,
    at: doc.at,
  };
}

export const DashboardVersionRepository: IDashboardVersionRepository = {
  async append(workspaceId, entry) {
    const doc = await DashboardVersionMongoModel.create({
      workspaceId,
      dashboardId: entry.dashboardId,
      version: entry.version,
      patch: entry.patch,
      inverse: entry.inverse,
      actorUserId: entry.actorUserId,
      ...setFields(entry, ['snapshot', 'actorAgentId', 'summary', 'at']),
    });
    return toDashboardVersionData(doc);
  },

  async list(workspaceId, dashboardId, limit) {
    const docs = await DashboardVersionMongoModel.find({ workspaceId, dashboardId })
      .sort({ version: -1 })
      .limit(limit)
      .lean<DashboardVersionFields[]>();
    return docs.map(toDashboardVersionData);
  },

  async findByVersion(workspaceId, dashboardId, version) {
    const doc = await DashboardVersionMongoModel.findOne({
      workspaceId,
      dashboardId,
      version,
    }).lean<DashboardVersionFields>();
    return doc ? toDashboardVersionData(doc) : null;
  },

  async pruneKeeping(workspaceId, dashboardId, keepLatest, keepVersions) {
    // Only versions at or below what this call has seen are candidates, so a version appended
    // after the read (a concurrent writer) is never deleted. limit(0) would mean "no limit", so
    // keeping none of the latest is its own case: everything up to the newest seen version.
    const newest = await DashboardVersionMongoModel.find(
      { workspaceId, dashboardId },
      { version: 1 },
    )
      .sort({ version: -1 })
      .limit(Math.max(keepLatest, 1))
      .lean<Pick<DashboardVersionFields, 'version'>[]>();
    if (newest.length === 0) return 0;
    const oldestKept = newest[newest.length - 1]?.version ?? 0;
    const older =
      keepLatest > 0
        ? { $lt: oldestKept, $nin: keepVersions }
        : { $lte: oldestKept, $nin: keepVersions };
    const result = await DashboardVersionMongoModel.deleteMany({
      workspaceId,
      dashboardId,
      version: older,
    });
    return result.deletedCount;
  },

  async deleteForWorkspace(workspaceId) {
    return (await DashboardVersionMongoModel.deleteMany({ workspaceId })).deletedCount;
  },
};
