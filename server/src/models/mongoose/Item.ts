import { randomUUID } from 'node:crypto';
import mongoose from 'mongoose';

import { ATTRIBUTE_KEY_PATTERN } from '../../types/attributes.js';
import {
  ITEM_KINDS,
  ITEM_STATUSES,
  SCHEDULED_KINDS,
  VISIBILITIES,
  type ItemStatus,
} from '../../types/domain.js';
import {
  ITEM_TABLE_NAME,
  localItemUrl,
  SWEEP_WINDOW_FIELDS,
  type CreateLocalItemInput,
  type IItemRepository,
  COPY_STATUSES,
  type ItemCopy,
  type ItemData,
  type ItemOverlay,
  type ItemOverrides,
  type ItemSweepOptions,
  type ItemUpsert,
  type LocalItemPatch,
  type MirroredItemPatch,
  type ScheduledItemPatch,
  type SweepWindow,
  type TravelLegFilter,
  type TravelLegWrite,
} from '../definitions/Item.js';
import type { AggregateOptions } from '../definitions/common.js';
import { stableStringify } from '../../utils/stableStringify.js';
import { MirroredItemError } from '../errors.js';
import {
  SourceSchema,
  scopedPipeline,
  orphanedResourcesFilter,
  setFields,
  softDeleteBySource,
  toSourceRef,
  upsertBySource,
  uuidIdField,
  type SourceUpsertStore,
  type StoredSource,
} from './common.js';

/** `copies` is absent from items stored before H5 (lean reads apply no defaults). */
type StoredCopy = Omit<ItemCopy, 'at'> & { at?: Date };
type ItemFields = Omit<ItemData, 'id' | 'copies'> & { _id: string; copies?: StoredCopy[] };

/** `bodyPreview` is a short preview; the full body stays at the source. */
export const BODY_PREVIEW_MAX = 500;

const copySchema = new mongoose.Schema<ItemCopy>(
  {
    integrationId: { type: String, required: true },
    provider: { type: String, required: true },
    externalId: { type: String, default: '' },
    key: { type: String, default: null },
    url: { type: String, default: '' },
    status: { type: String, enum: COPY_STATUSES, required: true },
    requestId: { type: String, required: true },
    at: { type: Date, default: (): Date => new Date() },
  },
  { _id: false },
);

const itemSchema = new mongoose.Schema<ItemFields>(
  {
    _id: uuidIdField,
    workspaceId: { type: String, required: true },
    integrationId: { type: String, default: null },
    containerId: { type: String, default: null },
    kind: { type: String, enum: ITEM_KINDS, required: true },
    topicId: { type: String, default: null },
    title: { type: String, required: true },
    bodyPreview: { type: String, default: null, maxlength: BODY_PREVIEW_MAX },
    status: { type: String, enum: ITEM_STATUSES, default: 'open' },
    statusRaw: { type: String, default: null },
    priority: { type: Number, default: null },
    startAt: { type: Date, default: null },
    dueAt: { type: Date, default: null },
    endAt: { type: Date, default: null },
    allDay: { type: Boolean, default: false },
    assignees: { type: [String], default: [] },
    labels: { type: [String], default: [] },
    parentId: { type: String, default: null },
    source: { type: SourceSchema, required: true },
    syncResource: { type: String, default: null },
    props: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, unknown> => ({}) },
    overlay: {
      pinned: { type: Boolean, default: null },
      note: { type: String, default: null },
      hidden: { type: Boolean, default: null },
      topicOverride: { type: String, default: null },
      calendarSync: { type: Boolean, default: null },
      plannedAt: { type: String, default: null },
      editedAt: { type: Date, default: null },
      copyOf: { type: String, default: null },
      copyOfOwner: { type: String, default: null },
      copyOfShared: { type: Boolean, default: null },
      attrs: { type: mongoose.Schema.Types.Mixed, default: (): Record<string, unknown> => ({}) },
      // Local stand-ins for fields the provider lacks (never written by a sync).
      overrides: {
        title: { type: String, default: null },
        status: { type: String, enum: ITEM_STATUSES, default: null },
        dueAt: { type: Date, default: null },
        allDay: { type: Boolean, default: null },
        startAt: { type: Date, default: null },
        priority: { type: Number, default: null, min: 0, max: 4 },
      },
    },
    visibility: { type: String, enum: VISIBILITIES, default: 'workspace' },
    ownerUserId: { type: String, default: null },
    closedAt: { type: Date, default: null },
    deletedAt: { type: Date, default: null },
    lastSeenAt: { type: Date, default: null },
    linkedItemIds: { type: [String], default: [] },
    copies: { type: [copySchema], default: [] },
  },
  // minimize: false keeps an empty `props` as {} instead of dropping the field.
  { timestamps: true, collection: ITEM_TABLE_NAME, minimize: false },
);

const NOT_DELETED = { deletedAt: null };

itemSchema.index(
  {
    workspaceId: 1,
    'source.provider': 1,
    'source.accountId': 1,
    'source.externalId': 1,
    integrationId: 1,
  },
  { unique: true },
); // upsert key: one copy per integration (two members may connect one account, ruling 8)
itemSchema.index({ workspaceId: 1, status: 1, dueAt: 1 }, { partialFilterExpression: NOT_DELETED }); // deadlines, donut
itemSchema.index({ workspaceId: 1, kind: 1, startAt: 1 }, { partialFilterExpression: NOT_DELETED }); // calendar
itemSchema.index(
  { workspaceId: 1, topicId: 1, status: 1 },
  { partialFilterExpression: NOT_DELETED },
); // topic filters
itemSchema.index({ workspaceId: 1, containerId: 1, dueAt: 1 }); // per course/project
itemSchema.index({ integrationId: 1, lastSeenAt: 1 }); // deletion sweep
itemSchema.index({ integrationId: 1, syncResource: 1, lastSeenAt: 1 }); // per-resource sweep
itemSchema.index({ deletedAt: 1 }, { partialFilterExpression: { deletedAt: { $type: 'date' } } }); // purge job
// Hebrew + English: no stemming. A mirrored item's title override is searched like its title (the
// title it shows); sync-db swaps the old text index for this one (one text index per collection).
itemSchema.index(
  { title: 'text', bodyPreview: 'text', 'overlay.overrides.title': 'text' },
  {
    weights: { title: 5, bodyPreview: 1, 'overlay.overrides.title': 5 },
    default_language: 'none',
  },
);

itemSchema.index(
  { workspaceId: 1, 'overlay.copyOf': 1 },
  { partialFilterExpression: { 'overlay.copyOf': { $type: 'string' } } },
); // a to-do's provider copies (H5)

// Idempotent local create: one item per owner and client key, permanently.
itemSchema.index(
  { workspaceId: 1, ownerUserId: 1, 'props.idempotencyKey': 1 },
  { unique: true, partialFilterExpression: { 'props.idempotencyKey': { $exists: true } } },
);

// A travel leg's key (owner|anchor|occurrence|direction): one leg per key, tombstones included.
itemSchema.index(
  { workspaceId: 1, 'props.travelKey': 1 },
  { unique: true, partialFilterExpression: { 'props.travelKey': { $type: 'string' } } },
);

export const ItemMongoModel = mongoose.model<ItemFields>('Item', itemSchema);

const LOCAL_PATCH_KEYS: readonly (keyof LocalItemPatch)[] = [
  'title',
  'topicId',
  'bodyPreview',
  'status',
  'priority',
  'startAt',
  'dueAt',
  'endAt',
  'allDay',
  'assignees',
  'labels',
  'parentId',
  'containerId',
  'props',
  'visibility',
  'closedAt',
];

const SCHEDULED_PATCH_KEYS: readonly (keyof ScheduledItemPatch)[] = [
  'title',
  'topicId',
  'bodyPreview',
  'startAt',
  'endAt',
  'props',
];

const MIRRORED_PATCH_KEYS: readonly (keyof MirroredItemPatch)[] = [
  'title',
  'status',
  'statusRaw',
  'priority',
  'startAt',
  'dueAt',
  'endAt',
  'allDay',
  'closedAt',
];

const OVERLAY_KEYS: readonly (keyof ItemOverlay)[] = [
  'pinned',
  'note',
  'hidden',
  'topicOverride',
  'calendarSync',
  'plannedAt',
  'editedAt',
  'copyOf',
  'copyOfOwner',
  'copyOfShared',
];

const OVERRIDE_KEYS: readonly (keyof ItemOverrides)[] = [
  'title',
  'status',
  'dueAt',
  'allDay',
  'startAt',
  'priority',
];

/** The overrides as stored (absent on items stored before Phase 4a: none). */
function toOverrides(stored: Partial<ItemOverrides> | undefined): ItemOverrides {
  return {
    title: stored?.title ?? null,
    status: stored?.status ?? null,
    dueAt: stored?.dueAt ?? null,
    allDay: stored?.allDay ?? null,
    startAt: stored?.startAt ?? null,
    priority: stored?.priority ?? null,
  };
}

/** At most 500 UTF-16 units, without splitting a surrogate pair (an emoji) at the cut. */
function toPreview(text: string | null | undefined): string | null {
  if (text === undefined || text === null || text.length <= BODY_PREVIEW_MAX) return text ?? null;
  const lastKept = text.charCodeAt(BODY_PREVIEW_MAX - 1);
  const splitsPair = lastKept >= 0xd800 && lastKept <= 0xdbff;
  return text.slice(0, splitsPair ? BODY_PREVIEW_MAX - 1 : BODY_PREVIEW_MAX);
}

/** A new local item's document, with its id (a local item's external id is its own id). */
function localItemDoc(
  workspaceId: string,
  input: CreateLocalItemInput,
  id: string,
): Record<string, unknown> {
  return {
    _id: id,
    workspaceId,
    integrationId: null,
    kind: input.kind ?? 'todo',
    topicId: input.topicId,
    title: input.title,
    ownerUserId: input.ownerUserId,
    ...setFields(withPreview(input), [
      'bodyPreview',
      'status',
      'priority',
      'startAt',
      'dueAt',
      'endAt',
      'allDay',
      'assignees',
      'labels',
      'parentId',
      'containerId',
      'props',
      'visibility',
    ]),
    source: {
      provider: 'local',
      accountId: '',
      externalId: id,
      key: null,
      url: localItemUrl(workspaceId, id),
      updatedAtSource: null,
      etag: null,
      hash: null,
    },
  };
}

/** A patch or input with its `bodyPreview` (when present) cut by the one preview rule. */
function withPreview<T extends { bodyPreview?: string | null }>(input: T): T {
  if (input.bodyPreview === undefined) return input;
  return { ...input, bodyPreview: toPreview(input.bodyPreview) };
}

function toItemData(doc: ItemFields): ItemData {
  const { overlay } = doc;
  return {
    id: doc._id,
    workspaceId: doc.workspaceId,
    integrationId: doc.integrationId ?? null,
    containerId: doc.containerId ?? null,
    kind: doc.kind,
    topicId: doc.topicId ?? null,
    title: doc.title,
    bodyPreview: doc.bodyPreview ?? null,
    status: doc.status,
    statusRaw: doc.statusRaw ?? null,
    priority: doc.priority ?? null,
    startAt: doc.startAt ?? null,
    dueAt: doc.dueAt ?? null,
    endAt: doc.endAt ?? null,
    allDay: doc.allDay,
    assignees: [...doc.assignees],
    labels: [...doc.labels],
    parentId: doc.parentId ?? null,
    source: toSourceRef(doc.source),
    syncResource: doc.syncResource ?? null,
    props: doc.props,
    overlay: {
      pinned: overlay.pinned ?? null,
      note: overlay.note ?? null,
      hidden: overlay.hidden ?? null,
      topicOverride: overlay.topicOverride ?? null,
      calendarSync: overlay.calendarSync ?? null,
      plannedAt: overlay.plannedAt ?? null,
      editedAt: overlay.editedAt ?? null,
      copyOf: overlay.copyOf ?? null,
      copyOfOwner: overlay.copyOfOwner ?? null,
      copyOfShared: overlay.copyOfShared ?? null,
      attrs: { ...overlay.attrs },
      overrides: toOverrides(overlay.overrides),
    },
    visibility: doc.visibility,
    ownerUserId: doc.ownerUserId ?? null,
    closedAt: doc.closedAt ?? null,
    deletedAt: doc.deletedAt ?? null,
    lastSeenAt: doc.lastSeenAt ?? null,
    linkedItemIds: [...doc.linkedItemIds],
    copies: (doc.copies ?? []).map((copy) => ({
      integrationId: copy.integrationId,
      provider: copy.provider,
      externalId: copy.externalId,
      key: copy.key,
      url: copy.url,
      status: copy.status,
      requestId: copy.requestId,
      at: copy.at ?? new Date(0),
    })),
    createdAt: doc.createdAt,
    updatedAt: doc.updatedAt,
  };
}

/** Every field the sync owns; left-out values are cleared. Overlay, owner and links are untouched. */
function syncedItemFields(item: ItemUpsert, seenAt: Date): Record<string, unknown> {
  return {
    integrationId: item.integrationId,
    containerId: item.containerId ?? null,
    kind: item.kind,
    topicId: item.topicId,
    title: item.title,
    bodyPreview: toPreview(item.bodyPreview),
    status: item.status,
    statusRaw: item.statusRaw ?? null,
    priority: item.priority ?? null,
    startAt: item.startAt ?? null,
    dueAt: item.dueAt ?? null,
    endAt: item.endAt ?? null,
    allDay: item.allDay ?? false,
    assignees: item.assignees ?? [],
    labels: item.labels ?? [],
    parentId: item.parentId ?? null,
    source: toSourceRef(item.source),
    syncResource: item.syncResource ?? null,
    props: item.props ?? {},
    closedAt: item.closedAt ?? null,
    deletedAt: item.deletedAt ?? null,
    lastSeenAt: seenAt,
  };
}

/** What bulkUpsert reads of a stored item: enough to tell whether a write closes it. */
interface StoredItem extends StoredSource {
  status?: ItemStatus;
  closedAt?: Date | null;
}

const itemStore: SourceUpsertStore<StoredItem> = {
  findStored: (filter) =>
    ItemMongoModel.find(filter, {
      integrationId: 1,
      source: 1,
      deletedAt: 1,
      status: 1,
      closedAt: 1,
    })
      .lean<StoredItem[]>()
      .exec(),
  findWritten: (filter) => ItemMongoModel.find(filter).lean<Record<string, unknown>[]>().exec(),
  bulkWrite: (writes) => ItemMongoModel.bulkWrite(writes),
};

const CLOSED_STATUSES: ReadonlySet<ItemStatus> = new Set(['done', 'cancelled']);

function isClosed(item: { status?: ItemStatus; closedAt?: Date | null }): boolean {
  return (
    item.status !== undefined &&
    CLOSED_STATUSES.has(item.status) &&
    (item.closedAt ?? null) !== null
  );
}

/** `{ <field>: { $gte: from, $lt: to } }`, for a time field a sweep may be bounded by only. */
function windowFilter(window: SweepWindow): Record<string, unknown> {
  if (!(SWEEP_WINDOW_FIELDS as readonly string[]).includes(window.field)) {
    throw new Error(`sweepUnseen: cannot bound a sweep by "${window.field}"`);
  }
  return { [window.field]: { $gte: window.from, $lt: window.to } };
}

/** The write closes the item: its stored copy was not closed, and nothing signals a delete. */
function closesItem(item: ItemUpsert, stored: StoredItem | undefined): boolean {
  return (
    stored !== undefined && (item.deletedAt ?? null) === null && isClosed(item) && !isClosed(stored)
  );
}

/**
 * A to-do's copies as list rows show them: `props.copies`, a plain copy of what the chips need
 * (a row of a dashboard block carries `props`, not the copies). Rewritten whenever the copies
 * change; the copies themselves stay the record.
 */
async function refreshCopyProps(workspaceId: string, id: string): Promise<ItemFields | null> {
  // One pipeline update from the stored copies: parallel targets cannot leave a stale list.
  return ItemMongoModel.findOneAndUpdate(
    { _id: id, workspaceId },
    [
      {
        $set: {
          'props.copies': {
            $map: {
              input: { $ifNull: ['$copies', []] },
              as: 'copy',
              in: {
                provider: '$$copy.provider',
                key: '$$copy.key',
                url: '$$copy.url',
                status: '$$copy.status',
                at: '$$copy.at',
              },
            },
          },
        },
      },
    ],
    { new: true },
  ).lean<ItemFields>();
}

/**
 * Live local items marked private whose owner is none of `memberIds`: former members' to-dos (and
 * time blocks). Never a travel leg: legs are no to-dos, and travel storage removes a leaving
 * member's legs itself (Ruling 25), so the count and the delete agree.
 */
function formerMembersPrivateLocal(
  workspaceId: string,
  memberIds: readonly string[],
): Record<string, unknown> {
  return {
    workspaceId,
    integrationId: null,
    visibility: 'private',
    deletedAt: null,
    ownerUserId: { $nin: [...memberIds] },
    kind: { $ne: 'travel' },
  };
}

/** Travel storage's legs: local items of kind `travel` with a key (the key's partial index). */
const TRAVEL_LEG = {
  kind: 'travel',
  'source.provider': 'local',
  'props.travelKey': { $type: 'string' },
} as const;

function isDuplicateKey(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === 11000;
}

/** Whether `stored` already holds what `leg` writes (live, same fields, same travel props). */
function holdsLeg(stored: ItemFields, leg: TravelLegWrite): boolean {
  return (
    (stored.deletedAt ?? null) === null &&
    stored.title === leg.title &&
    (stored.topicId ?? null) === leg.topicId &&
    stored.startAt?.getTime() === leg.startAt.getTime() &&
    stored.endAt?.getTime() === leg.endAt.getTime() &&
    stableStringify(stored.props['travel']) === stableStringify(leg.travel)
  );
}

/** Creates the leg, or answers null when another write made one with its key meanwhile. */
async function createTravelLeg(
  workspaceId: string,
  key: string,
  leg: TravelLegWrite,
): Promise<ItemData | null> {
  try {
    const doc = await ItemMongoModel.create(
      localItemDoc(
        workspaceId,
        {
          ownerUserId: leg.ownerUserId,
          title: leg.title,
          topicId: leg.topicId,
          kind: 'travel',
          startAt: leg.startAt,
          endAt: leg.endAt,
          allDay: false,
          visibility: 'private',
          props: { travel: leg.travel, travelKey: key },
        },
        randomUUID(),
      ),
    );
    return toItemData(doc);
  } catch (error) {
    if (isDuplicateKey(error)) return null;
    throw error;
  }
}

export const ItemRepository: IItemRepository = {
  async findById(workspaceId, id) {
    const doc = await ItemMongoModel.findOne({
      _id: id,
      workspaceId,
      deletedAt: null,
    }).lean<ItemFields>();
    return doc ? toItemData(doc) : null;
  },

  async createLocal(workspaceId, input) {
    const doc = await ItemMongoModel.create(localItemDoc(workspaceId, input, randomUUID()));
    return toItemData(doc);
  },

  async createLocalMany(workspaceId, inputs, at = new Date()) {
    if (inputs.length === 0) return [];
    const docs = await ItemMongoModel.insertMany(
      inputs.map(
        (input, index) =>
          new ItemMongoModel({
            ...localItemDoc(workspaceId, input, randomUUID()),
            createdAt: new Date(at.getTime() + index),
          }),
      ),
      { ordered: true },
    );
    return docs.map((doc) => toItemData(doc));
  },

  async updateLocal(workspaceId, id, patch) {
    const doc = await ItemMongoModel.findOneAndUpdate(
      {
        _id: id,
        workspaceId,
        deletedAt: null,
        'source.provider': 'local',
        // A to-do's path: reserved time is changed through updateScheduled only.
        kind: { $nin: [...SCHEDULED_KINDS] },
      },
      { $set: setFields(withPreview(patch), LOCAL_PATCH_KEYS) },
      { new: true, runValidators: true },
    ).lean<ItemFields>();
    if (doc) {
      // The to-do's sharing moved: its provider copies follow (they hide for whoever sees it).
      if (patch.visibility !== undefined && (doc.copies ?? []).length > 0) {
        await ItemMongoModel.updateMany(
          { workspaceId, 'overlay.copyOf': id },
          { $set: { 'overlay.copyOfShared': patch.visibility === 'workspace' } },
        );
      }
      return toItemData(doc);
    }

    const mirrored = await ItemMongoModel.findOne(
      { _id: id, workspaceId, deletedAt: null, 'source.provider': { $ne: 'local' } },
      { source: 1 },
    ).lean<Pick<ItemFields, '_id' | 'source'>>();
    if (mirrored) {
      throw new MirroredItemError(mirrored._id, mirrored.source.provider, mirrored.source.url);
    }
    return null;
  },
  async updateScheduled(workspaceId, id, kind, patch, options = {}) {
    const { unchangedSince } = options;
    // A guarded write stamps a time later than the one it read, so two writes in the same
    // millisecond still differ and a second guarded write on the first one's read misses.
    const stamp = new Date(Math.max(Date.now(), (unchangedSince?.getTime() ?? 0) + 1));
    const doc = await ItemMongoModel.findOneAndUpdate(
      {
        _id: id,
        workspaceId,
        deletedAt: null,
        'source.provider': 'local',
        kind,
        ...(unchangedSince === undefined ? {} : { updatedAt: unchangedSince }),
      },
      { $set: { ...setFields(withPreview(patch), SCHEDULED_PATCH_KEYS), updatedAt: stamp } },
      { new: true, runValidators: true, timestamps: false },
    ).lean<ItemFields>();
    return doc ? toItemData(doc) : null;
  },

  async upsertTravelLeg(workspaceId, key, leg) {
    // A create that loses a race to another write of the same key updates that leg instead.
    for (let attempt = 0; ; attempt += 1) {
      const stored = await ItemMongoModel.findOne({
        workspaceId,
        ...TRAVEL_LEG,
        'props.travelKey': key,
      }).lean<ItemFields>();
      if (stored === null) {
        const created = await createTravelLeg(workspaceId, key, leg);
        if (created !== null) return { item: created, outcome: 'created' };
        if (attempt > 0) throw new Error('upsertTravelLeg: the leg could not be written');
        continue;
      }
      if (stored.ownerUserId !== leg.ownerUserId) {
        throw new Error("upsertTravelLeg: a leg's key names its owner");
      }
      if (holdsLeg(stored, leg)) return { item: toItemData(stored), outcome: 'unchanged' };
      const doc = await ItemMongoModel.findOneAndUpdate(
        { _id: stored._id, workspaceId, ...TRAVEL_LEG },
        {
          $set: {
            title: leg.title,
            topicId: leg.topicId,
            startAt: leg.startAt,
            endAt: leg.endAt,
            'props.travel': leg.travel,
            deletedAt: null,
          },
        },
        { new: true, runValidators: true },
      ).lean<ItemFields>();
      if (doc === null) throw new Error('upsertTravelLeg: the leg went while it was written');
      return { item: toItemData(doc), outcome: 'updated' };
    }
  },

  async listTravelLegs(workspaceId, filter: TravelLegFilter) {
    const { ownerUserId, from, to, ids, includeRemoved = false } = filter;
    const startAt: Record<string, Date> = {};
    if (from !== undefined) startAt['$gte'] = from;
    if (to !== undefined) startAt['$lt'] = to;
    const docs = await ItemMongoModel.find({
      ...(Object.keys(startAt).length === 0 ? {} : { startAt }),
      ...(ids === undefined ? {} : { _id: { $in: [...ids] } }),
      ...(includeRemoved ? {} : { deletedAt: null }),
      workspaceId,
      ownerUserId,
      ...TRAVEL_LEG,
    })
      .sort({ startAt: 1, _id: 1 })
      .lean<ItemFields[]>();
    return docs.map(toItemData);
  },

  async removeTravelLeg(workspaceId, id, reason, at = new Date()) {
    // A pipeline write, so a leg whose travel props are not an object still becomes a tombstone.
    const doc = await ItemMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, deletedAt: null, ...TRAVEL_LEG },
      [
        {
          $set: {
            deletedAt: { $literal: at },
            'props.travel': {
              $mergeObjects: [
                {
                  $cond: [{ $eq: [{ $type: '$props.travel' }, 'object'] }, '$props.travel', {}],
                },
                { removedReason: { $literal: reason } },
              ],
            },
            updatedAt: '$$NOW',
          },
        },
      ],
      { new: true, timestamps: false },
    ).lean<ItemFields>();
    return doc ? toItemData(doc) : null;
  },

  async removeTravelLegsOf(workspaceId, ownerUserId, at = new Date()) {
    const result = await ItemMongoModel.updateMany(
      { workspaceId, ownerUserId, kind: 'travel', 'source.provider': 'local', deletedAt: null },
      { $set: { deletedAt: at } },
    );
    return result.modifiedCount;
  },

  async updateMirrored(workspaceId, integrationId, id, patch, options) {
    const set = {
      ...setFields(patch, MIRRORED_PATCH_KEYS),
      ...(options.resync ? { 'source.hash': null } : {}),
    };
    if (Object.keys(set).length === 0) return this.findById(workspaceId, id);
    const doc = await ItemMongoModel.findOneAndUpdate(
      {
        _id: id,
        workspaceId,
        integrationId,
        deletedAt: null,
        'source.provider': { $ne: 'local' },
      },
      { $set: set },
      { new: true, runValidators: true },
    ).lean<ItemFields>();
    return doc ? toItemData(doc) : null;
  },

  async setOverlay(workspaceId, id, overlay) {
    const set = {
      ...setFields(overlay, OVERLAY_KEYS, 'overlay.'),
      ...setFields(overlay.overrides ?? {}, OVERRIDE_KEYS, 'overlay.overrides.'),
    };
    const unset: Record<string, ''> = {};
    for (const [key, value] of Object.entries(overlay.attrs ?? {})) {
      // Attribute keys are slugs (the service checks them); refuse anything else as a path.
      if (!ATTRIBUTE_KEY_PATTERN.test(key)) throw new Error('Invalid attribute key');
      if (value === null) unset[`overlay.attrs.${key}`] = '';
      else set[`overlay.attrs.${key}`] = value;
    }
    const doc = await ItemMongoModel.findOneAndUpdate(
      { _id: id, workspaceId, deletedAt: null },
      {
        ...(Object.keys(set).length === 0 ? {} : { $set: set }),
        ...(Object.keys(unset).length === 0 ? {} : { $unset: unset }),
      },
      { new: true, runValidators: true },
    ).lean<ItemFields>();
    return doc ? toItemData(doc) : null;
  },

  async clearAttribute(workspaceId, key) {
    if (!ATTRIBUTE_KEY_PATTERN.test(key)) throw new Error('Invalid attribute key');
    const path = `overlay.attrs.${key}`;
    const result = await ItemMongoModel.updateMany(
      { workspaceId, [path]: { $exists: true } },
      { $unset: { [path]: '' } },
    );
    return result.modifiedCount;
  },

  async renameAttributeValue(workspaceId, key, from, to) {
    if (!ATTRIBUTE_KEY_PATTERN.test(key)) throw new Error('Invalid attribute key');
    const path = `overlay.attrs.${key}`;
    const result = await ItemMongoModel.updateMany(
      { workspaceId, [path]: from },
      { $set: { [path]: to } },
    );
    return result.modifiedCount;
  },

  async softDelete(workspaceId, id) {
    const result = await ItemMongoModel.updateOne(
      { _id: id, workspaceId, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
    if (result.modifiedCount === 0) return false;
    // Its provider copies become ordinary mirrored items again; nothing is deleted at the provider.
    await ItemMongoModel.updateMany(
      { workspaceId, 'overlay.copyOf': id },
      {
        $set: {
          'overlay.copyOf': null,
          'overlay.copyOfOwner': null,
          'overlay.copyOfShared': null,
        },
      },
    );
    return true;
  },

  async findBySource(workspaceId, account, externalId) {
    const doc = await ItemMongoModel.findOne({
      workspaceId,
      'source.provider': account.provider,
      'source.accountId': account.accountId,
      integrationId: account.integrationId,
      'source.externalId': externalId,
      deletedAt: null,
    }).lean<ItemFields>();
    return doc ? toItemData(doc) : null;
  },

  async addCopy(workspaceId, localId, copy, options = {}) {
    const result = await ItemMongoModel.updateOne(
      {
        _id: localId,
        workspaceId,
        deletedAt: null,
        'source.provider': 'local',
        // A to-do only: reserved time (a time block, a travel leg) is never copied to a provider.
        kind: { $nin: [...SCHEDULED_KINDS] },
        'copies.requestId': { $ne: copy.requestId },
        ...(options.allowActive === true
          ? {}
          : {
              copies: {
                $not: {
                  $elemMatch: {
                    integrationId: copy.integrationId,
                    status: { $in: ['pending', 'created', 'unknown'] },
                  },
                },
              },
            }),
      },
      { $push: { copies: copy } },
    );
    if (result.modifiedCount === 0) return false;
    await refreshCopyProps(workspaceId, localId);
    return true;
  },

  async updateCopy(workspaceId, localId, requestId, patch) {
    const set: Record<string, unknown> = {};
    for (const [key, value] of Object.entries(patch)) {
      set[`copies.$.${key}`] = value;
    }
    const doc = await ItemMongoModel.findOneAndUpdate(
      { _id: localId, workspaceId, 'copies.requestId': requestId },
      { $set: set },
      { new: true },
    ).lean<ItemFields>();
    if (doc === null) return null;
    const refreshed = await refreshCopyProps(workspaceId, localId);
    return toItemData(refreshed ?? doc);
  },

  async removeCopy(workspaceId, localId, requestId) {
    await ItemMongoModel.updateOne(
      { _id: localId, workspaceId },
      { $pull: { copies: { requestId } } },
    );
    await refreshCopyProps(workspaceId, localId);
  },

  async softDeleteForWorkspace(workspaceId) {
    const result = await ItemMongoModel.updateMany(
      { workspaceId, deletedAt: null },
      { $set: { deletedAt: new Date() } },
    );
    return result.modifiedCount;
  },

  async countPrivateLocalOfFormerMembers(workspaceId, memberIds) {
    return ItemMongoModel.countDocuments(formerMembersPrivateLocal(workspaceId, memberIds));
  },

  async softDeletePrivateLocalOfFormerMembers(workspaceId, memberIds) {
    const result = await ItemMongoModel.updateMany(
      formerMembersPrivateLocal(workspaceId, memberIds),
      { $set: { deletedAt: new Date() } },
    );
    return result.modifiedCount;
  },

  async bulkUpsert(workspaceId, docs, options = {}) {
    let closed = 0;
    const result = await upsertBySource(
      workspaceId,
      docs,
      itemStore,
      syncedItemFields,
      (item, stored) => {
        if (closesItem(item, stored)) closed += 1;
      },
      options,
    );
    return { ...result, closed };
  },

  async softDeleteBySource(workspaceId, account, externalIds, deletedAt = new Date()) {
    return softDeleteBySource(ItemMongoModel, workspaceId, account, externalIds, deletedAt);
  },

  async sweepUnseen(
    workspaceId: string,
    integrationId: string,
    resource: string,
    before: Date,
    options: ItemSweepOptions = {},
  ) {
    const { deletedAt = new Date(), keepExternalIds = [], window } = options;
    const result = await ItemMongoModel.updateMany(
      {
        // The window first, so the scope keys below always win.
        ...(window === undefined ? {} : windowFilter(window)),
        ...(keepExternalIds.length > 0
          ? { 'source.externalId': { $nin: [...keepExternalIds] } }
          : {}),
        workspaceId,
        integrationId,
        syncResource: resource,
        deletedAt: null,
        lastSeenAt: { $lt: before },
      },
      { $set: { deletedAt } },
    );
    return result.modifiedCount;
  },

  async sweepOrphanedResources(workspaceId, integrationId, resources, options = {}) {
    const { deletedAt = new Date(), keepExternalIds = [] } = options;
    const result = await ItemMongoModel.updateMany(
      orphanedResourcesFilter(workspaceId, integrationId, resources, keepExternalIds),
      { $set: { deletedAt } },
    );
    return result.modifiedCount;
  },

  async existsForIntegrations(workspaceId, integrationIds) {
    if (integrationIds.length === 0) return false;
    const found = await ItemMongoModel.exists({
      workspaceId,
      integrationId: { $in: [...integrationIds] },
    });
    return found !== null;
  },

  async softDeleteForIntegration(workspaceId, integrationId, deletedAt = new Date()) {
    const result = await ItemMongoModel.updateMany(
      { workspaceId, integrationId, deletedAt: null },
      { $set: { deletedAt } },
    );
    return result.modifiedCount;
  },

  async refileByContainer(workspaceId, integrationId, assignments) {
    if (assignments.length === 0) return 0;
    const result = await ItemMongoModel.bulkWrite(
      assignments.map(({ containerId, topicId }) => ({
        updateMany: {
          filter: {
            workspaceId,
            integrationId,
            containerId,
            deletedAt: null,
            topicId: { $ne: topicId },
          },
          update: { $set: { topicId } },
        },
      })),
    );
    return result.modifiedCount;
  },

  async unsetTopic(workspaceId, topicId) {
    const result = await ItemMongoModel.updateMany(
      { workspaceId, topicId },
      { $set: { topicId: null } },
    );
    await ItemMongoModel.updateMany(
      { workspaceId, 'overlay.topicOverride': topicId },
      { $set: { 'overlay.topicOverride': null } },
    );
    return result.modifiedCount;
  },

  // Global on purpose: the purge job runs over every workspace (jobs/purge.ts).
  async purgeDeletedBefore(date) {
    const result = await ItemMongoModel.deleteMany({
      deletedAt: { $lt: date },
      // A leg's tombstone tells why it went: it stays at least until its leg is over.
      $nor: [{ kind: 'travel', endAt: { $gte: date } }],
    });
    return result.deletedCount;
  },

  async aggregate<T>(
    workspaceId: string,
    stages: readonly Record<string, unknown>[],
    options: AggregateOptions = {},
  ) {
    return ItemMongoModel.aggregate<T>(scopedPipeline(workspaceId, stages), { ...options }).exec();
  },
};
