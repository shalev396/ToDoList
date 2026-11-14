import mongoose from 'mongoose';

import {
  WORKSPACE_TABLE_NAME,
  type TopicRule,
  type IWorkspaceRepository,
  type JoinLinkData,
  type WeekStart,
  type WorkspaceData,
  type WorkspaceSettings,
} from '../definitions/Workspace.js';
import { BUILTIN_IMPORTANCE, type AttributeDef } from '../../types/attributes.js';
import { setFields, uuidIdField } from './common.js';

type WorkspaceFields = Omit<WorkspaceData, 'id'> & { _id: string; joinLink?: JoinLinkData | null };

const WEEK_STARTS: readonly WeekStart[] = ['sun', 'mon'];

const topicRuleSchema = new mongoose.Schema<TopicRule>(
  {
    match: { type: String, required: true },
    topicId: { type: String, required: true },
  },
  { _id: false },
);

const workspaceSchema = new mongoose.Schema<WorkspaceFields>(
  {
    _id: uuidIdField,
    name: { type: String, required: true },
    slug: { type: String, required: true },
    ownerId: { type: String, required: true },
    settings: {
      timezone: { type: String, default: 'Asia/Jerusalem' },
      weekStart: { type: String, enum: WEEK_STARTS, default: 'sun' },
      topicRules: { type: [topicRuleSchema], default: [] },
      allowAgentPublish: { type: Boolean, default: false },
      attributes: { type: [mongoose.Schema.Types.Mixed], default: undefined },
    },
    joinLink: {
      type: new mongoose.Schema(
        {
          role: { type: String, enum: ['editor', 'viewer'], required: true },
          tokenHash: { type: String, required: true },
          enc: { type: mongoose.Schema.Types.Mixed, required: true },
          updatedAt: { type: Date, required: true },
        },
        { _id: false },
      ),
      default: null,
    },
    deletedAt: { type: Date, default: null },
  },
  { timestamps: true, collection: WORKSPACE_TABLE_NAME },
);

workspaceSchema.index({ slug: 1 }, { unique: true });
workspaceSchema.index({ ownerId: 1 });
// The join link's lookup: only workspaces with a link are indexed.
workspaceSchema.index({ 'joinLink.tokenHash': 1 }, { unique: true, sparse: true });

export const WorkspaceMongoModel = mongoose.model<WorkspaceFields>('Workspace', workspaceSchema);

const SETTINGS_KEYS: readonly (keyof WorkspaceSettings)[] = [
  'timezone',
  'weekStart',
  'topicRules',
  'allowAgentPublish',
];

/** Attributes are changed by their own methods, never through a settings patch. */
const PATCHABLE_SETTINGS = SETTINGS_KEYS.filter((key) => key !== 'attributes');

/** A document written before topics has no `topicRules` until the topics migration runs. */
function storedRules(settings: {
  topicRules?: readonly TopicRule[] | undefined;
}): readonly TopicRule[] {
  return settings.topicRules ?? [];
}

/** A workspace stored before attributes has none until the migration runs: the built-in is implied. */
function storedAttributes(settings: {
  attributes?: readonly AttributeDef[] | undefined;
}): AttributeDef[] {
  const stored = (settings.attributes ?? []).map((def) => ({ ...def }));
  return stored.some((def) => def.key === BUILTIN_IMPORTANCE.key)
    ? stored
    : [{ ...BUILTIN_IMPORTANCE }, ...stored];
}

function toWorkspaceData(doc: WorkspaceFields): WorkspaceData {
  return {
    id: doc._id,
    name: doc.name,
    slug: doc.slug,
    ownerId: doc.ownerId,
    settings: {
      timezone: doc.settings.timezone,
      weekStart: doc.settings.weekStart,
      topicRules: storedRules(doc.settings).map(({ match, topicId }) => ({ match, topicId })),
      allowAgentPublish: doc.settings.allowAgentPublish ?? false,
      attributes: storedAttributes(doc.settings),
    },
    deletedAt: doc.deletedAt ?? null,
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/**
 * A workspace stored before attributes (the migration has not run yet) gets the built-in Importance
 * stored on its first attribute write, so the cap counts it and it can be renamed. Idempotent.
 */
async function ensureBuiltIn(id: string): Promise<void> {
  const builtIn = { ...BUILTIN_IMPORTANCE };
  await WorkspaceMongoModel.updateOne(
    { _id: id, deletedAt: null, 'settings.attributes': { $exists: false } },
    { $set: { 'settings.attributes': [builtIn] } },
  );
  await WorkspaceMongoModel.updateOne(
    {
      _id: id,
      deletedAt: null,
      'settings.attributes': { $exists: true, $not: { $elemMatch: { key: builtIn.key } } },
    },
    // The driver's PushOperator type does not model `$position` on a dotted path.
    { $push: { 'settings.attributes': { $each: [builtIn], $position: 0 } } } as never,
  );
}

export const WorkspaceRepository: IWorkspaceRepository = {
  async create(input) {
    const doc = await WorkspaceMongoModel.create({
      name: input.name,
      slug: input.slug,
      ownerId: input.ownerId,
      settings: {
        ...setFields(input.settings ?? {}, PATCHABLE_SETTINGS),
        attributes: [{ ...BUILTIN_IMPORTANCE }],
      },
    });
    return toWorkspaceData(doc);
  },

  async findById(id) {
    const doc = await WorkspaceMongoModel.findOne({
      _id: id,
      deletedAt: null,
    }).lean<WorkspaceFields>();
    return doc ? toWorkspaceData(doc) : null;
  },

  async findBySlug(slug) {
    const doc = await WorkspaceMongoModel.findOne({ slug }).lean<WorkspaceFields>();
    return doc ? toWorkspaceData(doc) : null;
  },

  async listByIds(ids) {
    const docs = await WorkspaceMongoModel.find({
      _id: { $in: [...ids] },
      deletedAt: null,
    }).lean<WorkspaceFields[]>();
    return docs.map(toWorkspaceData);
  },

  async update(id, patch) {
    const doc = await WorkspaceMongoModel.findOneAndUpdate(
      { _id: id, deletedAt: null },
      {
        $set: {
          ...setFields(patch, ['name', 'slug']),
          ...setFields(patch.settings ?? {}, PATCHABLE_SETTINGS, 'settings.'),
        },
      },
      { new: true, runValidators: true },
    ).lean<WorkspaceFields>();
    return doc ? toWorkspaceData(doc) : null;
  },

  async appendTopicRule(id, rule, max) {
    // One write, conditioned on the current list: no rule with this match (literal, any case),
    // and fewer than `max` rules (no element at index max - 1).
    const sameMatch = new RegExp(`^${rule.match.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}$`, 'i');
    const result = await WorkspaceMongoModel.updateOne(
      {
        _id: id,
        deletedAt: null,
        'settings.topicRules': { $not: { $elemMatch: { match: sameMatch } } },
        [`settings.topicRules.${String(max - 1)}`]: { $exists: false },
      },
      { $push: { 'settings.topicRules': { match: rule.match, topicId: rule.topicId } } },
      { runValidators: true },
    );
    return result.modifiedCount > 0;
  },

  async pullTopicRules(id, topicId) {
    const before = await WorkspaceMongoModel.findOne(
      { _id: id },
      { 'settings.topicRules': 1 },
    ).lean<WorkspaceFields>();
    const count = (before?.settings.topicRules ?? []).filter(
      (rule) => rule.topicId === topicId,
    ).length;
    if (count === 0) return 0;
    await WorkspaceMongoModel.updateOne(
      { _id: id },
      { $pull: { 'settings.topicRules': { topicId } } },
    );
    return count;
  },

  async appendAttribute(id, def, max) {
    await ensureBuiltIn(id);
    const result = await WorkspaceMongoModel.updateOne(
      {
        _id: id,
        deletedAt: null,
        'settings.attributes': { $not: { $elemMatch: { key: def.key } } },
        [`settings.attributes.${String(max - 1)}`]: { $exists: false },
      },
      { $push: { 'settings.attributes': { ...def } } },
    );
    if (result.modifiedCount > 0) return 'added';
    const current = await WorkspaceMongoModel.findOne({ _id: id }).lean<WorkspaceFields>();
    const list = current === null ? [] : storedAttributes(current.settings);
    return list.some((entry) => entry.key === def.key) ? 'exists' : 'full';
  },

  async updateAttribute(id, key, patch) {
    await ensureBuiltIn(id);
    const set: Record<string, unknown> = {};
    for (const [name, value] of Object.entries(patch)) {
      set[`settings.attributes.$[a].${name}`] = value;
    }
    const doc = await WorkspaceMongoModel.findOneAndUpdate(
      { _id: id, deletedAt: null, 'settings.attributes.key': key },
      { $set: set },
      { new: true, arrayFilters: [{ 'a.key': key }] },
    ).lean<WorkspaceFields>();
    if (doc === null) return null;
    return storedAttributes(doc.settings).find((def) => def.key === key) ?? null;
  },

  async removeAttribute(id, key) {
    const result = await WorkspaceMongoModel.updateOne(
      { _id: id, deletedAt: null },
      { $pull: { 'settings.attributes': { key, builtIn: { $ne: true } } } },
    );
    return result.modifiedCount > 0;
  },

  async getJoinLink(id) {
    const doc = await WorkspaceMongoModel.findOne({
      _id: id,
      deletedAt: null,
    }).lean<WorkspaceFields>();
    const link = doc?.joinLink;
    return link
      ? { role: link.role, tokenHash: link.tokenHash, enc: link.enc, updatedAt: link.updatedAt }
      : null;
  },

  async setJoinLink(id, link) {
    const result = await WorkspaceMongoModel.updateOne(
      { _id: id, deletedAt: null },
      { $set: { joinLink: link } },
    );
    return result.matchedCount > 0;
  },

  async findByJoinTokenHash(tokenHash) {
    const doc = await WorkspaceMongoModel.findOne({
      'joinLink.tokenHash': tokenHash,
      deletedAt: null,
    }).lean<WorkspaceFields>();
    return doc ? toWorkspaceData(doc) : null;
  },

  async softDelete(id) {
    const result = await WorkspaceMongoModel.updateOne(
      { _id: id, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
    return result.modifiedCount > 0;
  },
};
