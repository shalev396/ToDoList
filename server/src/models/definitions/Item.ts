import type { ItemKind, ItemStatus, Visibility } from '../../types/domain.js';
import type {
  AggregateOptions,
  BulkUpsertResult,
  SourceAccount,
  SourceDeleteResult,
  SourceRef,
  SweepOptions,
} from './common.js';

/** User-only fields on any item, mirrored or local. The sync never touches them. */
export interface ItemOverlay {
  pinned: boolean | null;
  note: string | null;
  hidden: boolean | null;
  /** A topic this user files the item under instead of its own (a topic id). */
  topicOverride: string | null;
  calendarSync: boolean | null;
  editedAt: Date | null;
  /**
   * H5: this mirrored item is the provider copy of a local to-do (the local to-do's id). The base
   * filter hides it from whoever sees that to-do (copyAbsorptionFilter); null on every other item.
   */
  copyOf: string | null;
  /** The local to-do's owner, kept with `copyOf` so the filter needs no join. */
  copyOfOwner: string | null;
  /** Whether the local to-do is shared with the workspace; follows its visibility. */
  copyOfShared: boolean | null;
  /**
   * Custom attribute values by key (H4: types/attributes.ts). Never written to a provider. In
   * `setOverlay`, a key given as null is cleared.
   */
  attrs: Record<string, unknown>;
}

/** How far a provider copy of a local to-do got (H5). `unknown`: sent, no answer: may exist. */
export const COPY_STATUSES = ['pending', 'created', 'failed', 'unknown'] as const;
export type CopyStatus = (typeof COPY_STATUSES)[number];

/** One copy of a local to-do at a provider the user created it in (H5, D19). */
export interface ItemCopy {
  integrationId: string;
  provider: string;
  /** The provider's id of the created record ('' until created). */
  externalId: string;
  /** Jira key, Linear identifier, GitHub `owner/repo#n`. */
  key: string | null;
  url: string;
  status: CopyStatus;
  /** Client-generated: a repeat with the same id never creates twice. */
  requestId: string;
  /** When the copy was started: a `pending` one this old reads as `unknown`. */
  at: Date;
}

/** A copy still `pending` after this long is `unknown`: the request that made it is gone. */
export const PENDING_COPY_MAX_MS = 2 * 60 * 1000;

/** The status a copy reads as now: a stale `pending` is `unknown`. */
export function effectiveCopyStatus(
  copy: Pick<ItemCopy, 'status' | 'at'>,
  now: Date = new Date(),
): CopyStatus {
  return copy.status === 'pending' && now.getTime() - copy.at.getTime() > PENDING_COPY_MAX_MS
    ? 'unknown'
    : copy.status;
}

/** One to-do, issue, task, event, assignment, deadline, file, message or PR (DATA.md §3.6). */
export interface ItemData {
  id: string;
  workspaceId: string;
  /** null for local items. */
  integrationId: string | null;
  containerId: string | null;
  kind: ItemKind;
  /** The topic (page) it belongs to; null = Unsorted (its topic was deleted, or none applied). */
  topicId: string | null;
  title: string;
  /** At most 500 characters; the full body stays at the source. */
  bodyPreview: string | null;
  status: ItemStatus;
  statusRaw: string | null;
  priority: number | null;
  startAt: Date | null;
  dueAt: Date | null;
  endAt: Date | null;
  allDay: boolean;
  assignees: string[];
  labels: string[];
  parentId: string | null;
  source: SourceRef;
  /**
   * The adapter resource that last wrote this mirrored item (e.g. `issues`, `calendar:<id>`): a
   * full sync of a resource sweeps only its own unseen items. null for local items.
   */
  syncResource: string | null;
  props: Record<string, unknown>;
  overlay: ItemOverlay;
  visibility: Visibility;
  ownerUserId: string | null;
  closedAt: Date | null;
  deletedAt: Date | null;
  lastSeenAt: Date | null;
  linkedItemIds: string[];
  /** Provider copies of this local to-do (H5); empty for every other item. */
  copies: ItemCopy[];
  createdAt: Date;
  updatedAt: Date;
}

/** A dashboard-owned item. Its source is `local`, with `externalId` = its id. */
export interface CreateLocalItemInput {
  ownerUserId: string;
  title: string;
  topicId: string | null;
  kind?: ItemKind;
  bodyPreview?: string | null;
  status?: ItemStatus;
  priority?: number | null;
  startAt?: Date | null;
  dueAt?: Date | null;
  endAt?: Date | null;
  allDay?: boolean;
  assignees?: string[];
  labels?: string[];
  parentId?: string | null;
  containerId?: string | null;
  props?: Record<string, unknown>;
  visibility?: Visibility;
}

/** What may change on a local item. */
export interface LocalItemPatch {
  title?: string;
  topicId?: string | null;
  kind?: ItemKind;
  bodyPreview?: string | null;
  status?: ItemStatus;
  priority?: number | null;
  startAt?: Date | null;
  dueAt?: Date | null;
  endAt?: Date | null;
  allDay?: boolean;
  assignees?: string[];
  labels?: string[];
  parentId?: string | null;
  containerId?: string | null;
  props?: Record<string, unknown>;
  visibility?: Visibility;
  closedAt?: Date | null;
}

/**
 * One provider record mapped by a sync: every field the sync owns. Fields left out are written as
 * null / empty, so a value cleared at the source is cleared here too. The overlay, visibility,
 * owner and linked items belong to users and are never written.
 */
export interface ItemUpsert {
  integrationId: string;
  containerId?: string | null;
  kind: ItemKind;
  topicId: string | null;
  title: string;
  /** Cut to 500 characters. */
  bodyPreview?: string | null;
  status: ItemStatus;
  statusRaw?: string | null;
  priority?: number | null;
  startAt?: Date | null;
  dueAt?: Date | null;
  endAt?: Date | null;
  allDay?: boolean;
  assignees?: string[];
  labels?: string[];
  parentId?: string | null;
  source: SourceRef;
  /**
   * Set by the sync engine, never by an adapter: the resource the record came from. Written on
   * every upsert, unchanged ones included, and not part of `source.hash`.
   */
  syncResource?: string | null;
  props?: Record<string, unknown>;
  closedAt?: Date | null;
  /** Set when the provider signals a delete (Google `status: "cancelled"`). */
  deletedAt?: Date | null;
}

/** The item time fields a windowed listing can be bounded by. */
export const SWEEP_WINDOW_FIELDS = ['startAt', 'dueAt'] as const;

/** What a windowed listing covered: items whose `field` lies in [from, to). */
export interface SweepWindow {
  field: (typeof SWEEP_WINDOW_FIELDS)[number];
  from: Date;
  to: Date;
}

export interface ItemSweepOptions extends SweepOptions {
  /** Sweep only items whose `window.field` lies in [from, to). */
  window?: SweepWindow;
}

/** What an items bulkUpsert did. */
export interface ItemBulkUpsertResult extends BulkUpsertResult {
  /**
   * Items closed at the source by this write (part of `updated`): the stored copy was not closed,
   * the record is `done` or `cancelled` with `closedAt` set. A first sight of a closed item, or a
   * record that also carries `deletedAt`, is not counted.
   */
  closed: number;
}

export interface IItemRepository {
  /** Soft-deleted items are not found. */
  findById(workspaceId: string, id: string): Promise<ItemData | null>;
  createLocal(workspaceId: string, input: CreateLocalItemInput): Promise<ItemData>;
  /** Local items only: a mirrored item throws MirroredItemError (edit it at the source). */
  updateLocal(workspaceId: string, id: string, patch: LocalItemPatch): Promise<ItemData | null>;
  /** Only the overlay fields given change. Works on mirrored and local items. */
  setOverlay(
    workspaceId: string,
    id: string,
    overlay: Partial<ItemOverlay>,
  ): Promise<ItemData | null>;
  /**
   * Sets `deletedAt`. False when there was nothing to delete. The item's provider copies are
   * released (`overlay.copyOf` cleared): they show as normal mirrored items. Nothing is deleted at
   * the provider.
   */
  softDelete(workspaceId: string, id: string): Promise<boolean>;
  /** H5: the live item with this natural key. */
  findBySource(
    workspaceId: string,
    account: SourceAccount,
    externalId: string,
  ): Promise<ItemData | null>;
  /**
   * H5: records a copy on a local to-do. False when a copy with this `requestId` exists already
   * (a repeat), when (unless `allowActive`) a copy at the same integration is pending, created
   * or unknown (the claim is atomic per to-do and integration), or the item is not a live local one.
   */
  addCopy(
    workspaceId: string,
    localId: string,
    copy: ItemCopy,
    options?: { allowActive?: boolean },
  ): Promise<boolean>;
  /** H5: changes the copy with this `requestId`. The updated item; null when there is none. */
  updateCopy(
    workspaceId: string,
    localId: string,
    requestId: string,
    patch: Partial<Pick<ItemCopy, 'externalId' | 'key' | 'url' | 'status'>>,
  ): Promise<ItemData | null>;
  /** H5: removes a copy that never reached the provider, so a retry starts afresh. */
  removeCopy(workspaceId: string, localId: string, requestId: string): Promise<void>;
  /**
   * Sets `deletedAt` on every item of the workspace, local and mirrored (workspace deletion).
   * The purge job removes them later. Returns how many.
   */
  softDeleteForWorkspace(workspaceId: string): Promise<number>;
  /**
   * Local items marked private whose owner is none of `memberIds` (former members' to-dos,
   * PERMISSIONS-V2 ruling 6), not deleted: how many. Never their content.
   */
  countPrivateLocalOfFormerMembers(
    workspaceId: string,
    memberIds: readonly string[],
  ): Promise<number>;
  /** Soft-deletes those (the purge job removes them 30 days later). Returns how many. */
  softDeletePrivateLocalOfFormerMembers(
    workspaceId: string,
    memberIds: readonly string[],
  ): Promise<number>;
  /**
   * Natural-key upserts on (workspaceId, source.provider, source.accountId, source.externalId).
   * Same `source.hash` as stored: only `lastSeenAt` and `syncResource` are touched (unchanged). A
   * soft-deleted item seen again is restored. A record carrying `deletedAt` whose stored copy is
   * already deleted is unchanged too: its `deletedAt` (the purge clock) is kept.
   */
  bulkUpsert(workspaceId: string, docs: readonly ItemUpsert[]): Promise<ItemBulkUpsertResult>;
  /**
   * Delete-only records (a provider's delete signal that carries only ids): sets `deletedAt` on
   * the live items with these external ids of one provider account, and changes nothing else. An
   * item already deleted keeps its `deletedAt`; an id with no stored item is ignored.
   */
  softDeleteBySource(
    workspaceId: string,
    account: SourceAccount,
    externalIds: readonly string[],
    deletedAt?: Date,
  ): Promise<SourceDeleteResult>;
  /**
   * The deletion sweep after a full sync of one resource (DATA.md §4): this integration's live
   * items stamped with `resource` and `lastSeenAt < before` get `deletedAt`, except the kept
   * external ids and, with a window, items outside it. Returns how many were marked.
   */
  sweepUnseen(
    workspaceId: string,
    integrationId: string,
    resource: string,
    before: Date,
    options?: ItemSweepOptions,
  ): Promise<number>;
  /**
   * The orphaned-resource sweep, after a sync run in which every listed resource completed: this
   * integration's live items stamped with a resource not in `resources` (a calendar removed from
   * the config, say) get `deletedAt`, except the kept external ids. Items with no resource (local,
   * or written before resources were stamped) are left alone. Returns how many were marked.
   */
  sweepOrphanedResources(
    workspaceId: string,
    integrationId: string,
    resources: readonly string[],
    options?: SweepOptions,
  ): Promise<number>;
  /**
   * Sets `deletedAt` (default now) on this integration's live items: a disconnect, or a sync run
   * that finds its integration disconnected. Returns how many.
   */
  softDeleteForIntegration(
    workspaceId: string,
    integrationId: string,
    deletedAt?: Date,
  ): Promise<number>;
  /**
   * A topic was deleted: its items, deleted ones included, become Unsorted (`topicId: null`), and
   * overlays filing an item under it are cleared. Nothing else changes. Returns how many items.
   */
  unsetTopic(workspaceId: string, topicId: string): Promise<number>;
  /** Clears one attribute's value on every item of the workspace. Returns how many items held it. */
  clearAttribute(workspaceId: string, key: string): Promise<number>;
  /**
   * GLOBAL, every workspace: the nightly purge job (jobs/purge.ts) only. Hard-deletes items
   * soft-deleted before `date`. Returns how many.
   */
  purgeDeletedBefore(date: Date): Promise<number>;
  /**
   * Runs the stages after `{ $match: { workspaceId } }`. Stages that read other collections or
   * write are refused. `options.maxTimeMS` caps the server-side run time.
   */
  aggregate<T = Record<string, unknown>>(
    workspaceId: string,
    stages: readonly Record<string, unknown>[],
    options?: AggregateOptions,
  ): Promise<T[]>;
}

export const ITEM_TABLE_NAME = 'Items';

/**
 * `source.url` of a local item: a deep link into the app, since it has no provider page
 * (BACKEND.md §7). The app route that serves it is the frontend's to define.
 */
export function localItemUrl(workspaceId: string, itemId: string): string {
  return `/w/${workspaceId}/items/${itemId}`;
}
