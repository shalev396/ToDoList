import mongoose from 'mongoose';

import {
  AUDIT_LOG_TABLE_NAME,
  type AuditLogData,
  type IAuditLogRepository,
} from '../definitions/AuditLog.js';
import { setFields, uuidIdField } from './common.js';

type AuditLogFields = Omit<AuditLogData, 'id'> & { _id: string };

/** Entries are removed after 365 days (TTL on `at`). */
const RETENTION_SECONDS = 365 * 24 * 60 * 60;

// No timestamps: `at` is the entry's time, and entries never change.
const auditLogSchema = new mongoose.Schema<AuditLogFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    actorUserId: { type: String, required: true },
    actorAgentId: { type: String, default: null },
    action: { type: String, required: true },
    targetType: { type: String, default: null },
    targetId: { type: String, default: null },
    ip: { type: String, default: null },
    userAgent: { type: String, default: null },
    meta: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, unknown> => ({}) },
    at: { type: Date, default: (): Date => new Date() },
  },
  // minimize: false keeps an empty `meta` as {} instead of dropping the field.
  { collection: AUDIT_LOG_TABLE_NAME, minimize: false },
);

auditLogSchema.index({ workspaceId: 1, at: -1 });
auditLogSchema.index({ at: 1 }, { expireAfterSeconds: RETENTION_SECONDS });
auditLogSchema.index(
  { workspaceId: 1, actorAgentId: 1, at: -1 },
  { partialFilterExpression: { actorAgentId: { $type: 'string' } } },
); // "what did agent X do"

export const AuditLogMongoModel = mongoose.model<AuditLogFields>('AuditLog', auditLogSchema);

/** `meta.<key>` filters: plain names only, so a key can never be an operator or a path. */
function metaFilter(metaEquals: Record<string, string>): Record<string, string> {
  const filter: Record<string, string> = {};
  for (const [key, value] of Object.entries(metaEquals)) {
    if (!/^[A-Za-z0-9_]+$/.test(key)) throw new Error('findRecent: invalid metaEquals key');
    filter[`meta.${key}`] = value;
  }
  return filter;
}

function toAuditLogData(doc: AuditLogFields): AuditLogData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    actorUserId: doc.actorUserId,
    actorAgentId: doc.actorAgentId ?? null,
    action: doc.action,
    targetType: doc.targetType ?? null,
    targetId: doc.targetId ?? null,
    ip: doc.ip ?? null,
    userAgent: doc.userAgent ?? null,
    meta: doc.meta,
    at: doc.at,
  };
}

/** Append-only: no update or delete method. Entries leave only through the 365-day TTL. */
export const AuditLogRepository: IAuditLogRepository = {
  async append(workspaceId, entry) {
    const doc = await AuditLogMongoModel.create({
      workspaceId,
      actorUserId: entry.actorUserId,
      action: entry.action,
      ...setFields(entry, [
        'actorAgentId',
        'targetType',
        'targetId',
        'ip',
        'userAgent',
        'meta',
        'at',
      ]),
    });
    return toAuditLogData(doc);
  },

  async list(workspaceId, filter, limit) {
    const { before } = filter;
    const docs = await AuditLogMongoModel.find({
      ...setFields(filter, ['actorAgentId', 'action']),
      ...(filter.since ? { at: { $gte: filter.since } } : {}),
      ...(before === undefined
        ? {}
        : { $or: [{ at: { $lt: before.at } }, { at: before.at, _id: { $lt: before.id } }] }),
      workspaceId,
    })
      .sort({ at: -1, _id: -1 })
      .limit(limit)
      .lean<AuditLogFields[]>();
    return docs.map(toAuditLogData);
  },

  async findRecent(workspaceId, query) {
    const doc = await AuditLogMongoModel.findOne({
      ...metaFilter(query.metaEquals),
      ...setFields(query, ['actorAgentId']),
      action: query.action,
      at: { $gte: query.since },
      workspaceId,
    })
      .sort({ at: -1 })
      .lean<AuditLogFields>();
    return doc ? toAuditLogData(doc) : null;
  },
};
