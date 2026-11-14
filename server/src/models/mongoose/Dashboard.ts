import mongoose from 'mongoose';

import { VAR_NAME_PATTERN } from '../../types/builder.js';
import { DASHBOARD_PAGES, VISIBILITIES } from '../../types/domain.js';
import {
  DASHBOARD_TABLE_NAME,
  type DashboardData,
  type DashboardReplacement,
  type IDashboardRepository,
} from '../definitions/Dashboard.js';
import { setFields, uuidIdField } from './common.js';

// `views` is absent on dashboards written before views (lean reads apply no defaults).
type DashboardFields = Omit<DashboardData, 'id' | 'views'> & {
  _id: string;
  views?: unknown[];
};

const { Mixed } = mongoose.Schema.Types;

const dashboardSchema = new mongoose.Schema<DashboardFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    ownerUserId: { type: String, required: true },
    scope: {
      topicId: { type: String, default: null },
      containerId: { type: String, default: null },
      page: { type: String, enum: DASHBOARD_PAGES, default: 'topic' },
      // Group pages: the $page variable the route sets (a variable name, VAR_NAME_PATTERN).
      groupVar: { type: String, default: null, match: VAR_NAME_PATTERN },
    },
    title: { type: String, required: true },
    templateKey: { type: String, default: null },
    visibility: { type: String, enum: VISIBILITIES, default: 'workspace' },
    vars: { type: Mixed, default: (): Record<string, unknown> => ({}) },
    layouts: {
      lg: { type: [Mixed], default: [] },
      md: { type: [Mixed], default: [] },
      sm: { type: [Mixed], default: [] },
    },
    blocks: { type: [Mixed], default: [] },
    // The page's importance preset {preset, params} (H4); null = Weighted with the defaults.
    importance: { type: Mixed, default: null },
    // The page's views after the Summary (H3): {id, type, title, blockIds}; the blocks are above.
    views: { type: [Mixed], default: [] },
    version: { type: Number, default: 1 },
    publishedVersion: { type: Number, default: null },
    // Snapshot {title, vars, layouts, blocks} taken at publish time: what viewers see.
    published: { type: Mixed, default: null },
    updatedBy: {
      userId: { type: String, default: null },
      agentId: { type: String, default: null },
    },
    deletedAt: { type: Date, default: null },
  },
  // minimize: false keeps an empty `vars` as {} instead of dropping the field.
  { timestamps: true, collection: DASHBOARD_TABLE_NAME, minimize: false },
);

dashboardSchema.index(
  { workspaceId: 1, 'scope.topicId': 1, 'scope.containerId': 1 },
  { partialFilterExpression: { deletedAt: null } },
);
dashboardSchema.index({ workspaceId: 1, ownerUserId: 1 });
// Share-on-attach (PERMISSIONS-V2): listConnectorIds' distinct() and listWithConnector read the
// connectors of the drafts and of the published copies from these, not from every dashboard.
dashboardSchema.index(
  { workspaceId: 1, 'blocks.connectors': 1 },
  { partialFilterExpression: { deletedAt: null } },
);
dashboardSchema.index(
  { workspaceId: 1, 'published.blocks.connectors': 1 },
  { partialFilterExpression: { deletedAt: null } },
);

export const DashboardMongoModel = mongoose.model<DashboardFields>('Dashboard', dashboardSchema);

const REPLACEMENT_KEYS: readonly (keyof DashboardReplacement)[] = [
  'title',
  'scope',
  'templateKey',
  'visibility',
  'vars',
  'layouts',
  'blocks',
  'importance',
  'views',
  'publishedVersion',
  'published',
  'updatedBy',
];

function toDashboardData(doc: DashboardFields): DashboardData {
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    ownerUserId: doc.ownerUserId,
    scope: {
      topicId: doc.scope.topicId ?? null,
      containerId: doc.scope.containerId ?? null,
      page: doc.scope.page,
      groupVar: doc.scope.groupVar ?? null,
    },
    title: doc.title,
    templateKey: doc.templateKey ?? null,
    visibility: doc.visibility,
    vars: doc.vars,
    layouts: { lg: [...doc.layouts.lg], md: [...doc.layouts.md], sm: [...doc.layouts.sm] },
    blocks: [...doc.blocks],
    importance: doc.importance ?? null,
    views: [...(doc.views ?? [])],
    version: doc.version,
    publishedVersion: doc.publishedVersion ?? null,
    published: doc.published ?? null,
    updatedBy: {
      userId: doc.updatedBy.userId ?? null,
      agentId: doc.updatedBy.agentId ?? null,
    },
    deletedAt: doc.deletedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

export const DashboardRepository: IDashboardRepository = {
  async create(workspaceId, input) {
    const doc = await DashboardMongoModel.create({
      workspaceId,
      ownerUserId: input.ownerUserId,
      title: input.title,
      scope: setFields(input.scope ?? {}, ['topicId', 'containerId', 'page', 'groupVar']),
      ...setFields(input, [
        'templateKey',
        'visibility',
        'vars',
        'layouts',
        'blocks',
        'importance',
        'views',
        'updatedBy',
      ]),
    });
    return toDashboardData(doc);
  },

  async findById(workspaceId, id) {
    const doc = await DashboardMongoModel.findOne({
      _id: id,
      workspaceId,
      deletedAt: null,
    }).lean<DashboardFields>();
    return doc ? toDashboardData(doc) : null;
  },

  async list(workspaceId, filter) {
    const docs = await DashboardMongoModel.find({
      ...setFields(filter, ['topicId', 'page'], 'scope.'),
      workspaceId,
      deletedAt: null,
    })
      .sort({ createdAt: 1 })
      .lean<DashboardFields[]>();
    return docs.map(toDashboardData);
  },

  async listConnectorIds(workspaceId) {
    const live = { workspaceId, deletedAt: null };
    // distinct() flattens both arrays: blocks[], then each block's connectors[].
    const [drafts, published] = await Promise.all([
      DashboardMongoModel.distinct('blocks.connectors', live),
      DashboardMongoModel.distinct('published.blocks.connectors', live),
    ]);
    const ids = new Set<string>();
    for (const value of [...drafts, ...published] as unknown[]) {
      if (typeof value === 'string') ids.add(value);
    }
    return [...ids];
  },

  async listWithConnector(workspaceId, connectorId) {
    const docs = await DashboardMongoModel.find({
      workspaceId,
      deletedAt: null,
      $or: [{ 'blocks.connectors': connectorId }, { 'published.blocks.connectors': connectorId }],
    })
      .sort({ createdAt: 1 })
      .lean<DashboardFields[]>();
    return docs.map(toDashboardData);
  },

  async replaceIfVersion(workspaceId, id, expectedVersion, next) {
    if (!Number.isInteger(expectedVersion)) {
      throw new TypeError('replaceIfVersion: expectedVersion must be an integer');
    }
    // One atomic update: it matches only while the stored version is still the expected one,
    // and the database increments it.
    const doc = await DashboardMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, version: expectedVersion, deletedAt: null },
      { $set: setFields(next, REPLACEMENT_KEYS), $inc: { version: 1 } },
      { new: true, runValidators: true },
    ).lean<DashboardFields>();
    return doc ? toDashboardData(doc) : null;
  },

  async setPublished(workspaceId, id, version, snapshot) {
    if (!Number.isInteger(version)) {
      throw new TypeError('setPublished: version must be an integer');
    }
    // Matches only while the draft is still at `version`: what is published is what was read.
    const doc = await DashboardMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, version, deletedAt: null },
      { $set: { published: snapshot, publishedVersion: version } },
      { new: true, runValidators: true },
    ).lean<DashboardFields>();
    return doc ? toDashboardData(doc) : null;
  },

  async softDelete(workspaceId, id) {
    const result = await DashboardMongoModel.updateOne(
      { _id: id, workspaceId, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  },

  async softDeleteForTopic(workspaceId, topicId) {
    const result = await DashboardMongoModel.updateMany(
      { workspaceId, 'scope.topicId': topicId, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
    return result.modifiedCount;
  },
};
