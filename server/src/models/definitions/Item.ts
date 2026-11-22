import type { ItemKind, ItemStatus, ScheduledKind, Visibility } from '../../types/domain.js';
export { OVERRIDABLE_FIELDS, type OverridableField } from '../../types/items.js';
import type {
  AggregateOptions,
  BulkUpsertOptions,
  BulkUpsertResult,
  SourceAccount,
  SourceDeleteResult,
  SourceRef,
  SweepOptions,
} from './common.js';

/**
 * Values kept in TodoList for fields a mirrored item's provider lacks for its kind (GitHub's due
 * date, Jira's start date, anything of a pull request): what the item reads as is the override
 * when set, else what the provider sent (`override ?? source`). Null: no override. The sync never
 * touches them; a local to-do has none (it edits its own fields).
 */
export interface ItemOverrides {
  title: string | null;
  status: ItemStatus | null;
  dueAt: Date | null;
  /** With a `dueAt` override: it has no time of day (null: as the item is). */
  allDay: boolean | null;
  startAt: Date | null;
  /** 0 (lowest) … 4 (highest). */
  priority: number | null;
}

/** User-only fields on any item, mirrored or local. The sync never touches them. */
export interface ItemOverlay {
  pinned: boolean | null;
  note: string | null;
  hidden: boolean | null;
  /** A topic this user files the item under instead of its own (a topic id). */
  topicOverride: string | null;
  calendarSync: boolean | null;
  /**
   * When the user plans to do it: `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm`, the workspace's local time
   * (classes/item/PlannedAt.ts). Pushed to the workspace calendar; never synced or written to a
   * provider.
   */
  plannedAt: string | null;
  editedAt: Date | null;
  /**
   * H5: this mirrored item is the provider copy of a local to-do (the local to-do's id). A list
   * read hides it while that to-do shows in the same read (ItemAccessFilter.copyAbsorption); null
   * on every other item.
   */
  copyOf: string | null;
  /**
   * The local to-do's owner, kept with `copyOf`. No read depends on it any more: the absorption
   * looks for the to-do itself in the read.
   */
  copyOfOwner: string | null;
  /** Whether the local to-do is shared with the workspace; follows its visibility (as above). */
  copyOfShared: boolean | null;
  /**
   * Custom attribute values by key (H4: types/attributes.ts). Never written to a provider. In
   * `setOverlay`, a key given as null is cleared.
   */
  attrs: Record<string, unknown>;
  /**
   * Disabled in TodoList (classes/item/Disabled.ts): drawn faded and struck through, its time free
   * (never busy, never a travel anchor, never pushed). On a series, every occurrence; on a Google
   * series it is set on the master and on each exception row together. Never written to a provider.
   */
  disabled: boolean | null;
  /**
   * A series' occurrences disabled one by one (a local series, or a Google master's own slots), by
   * original start, ISO 8601, sorted, at most DISABLED_OCCURRENCES_MAX (the oldest go first).
   */
  disabledOccurrences: string[];
  /** Local stand-ins for fields the provider lacks (mirrored items only; never synced). */
  overrides: ItemOverrides;
}

/** The most occurrences one series disables one by one (`overlay.disabledOccurrences`). */
export const DISABLED_OCCURRENCES_MAX = 366;

/**
 * One Google series as stored for one integration: its master's `props.eventId` (an exception
 * row's `props.recurringEventId`) on one calendar.
 */
export interface GoogleSeriesRef {
  integrationId: string;
  accountId: string;
  calendarId: string;
  eventId: string;
}

/** What `setOverlay` takes: overlay fields, and override fields (null clears one). */
export type ItemOverlayPatch = Partial<Omit<ItemOverlay, 'overrides'>> & {
  overrides?: Partial<ItemOverrides>;
};

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

/** What may change on a local to-do (its kind never: a to-do stays a to-do). */
export interface LocalItemPatch {
  title?: string;
  topicId?: string | null;
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
 * What may change on TodoList's own reserved time (a time block, an area, a travel leg): its
 * title, topic, note, times and `props` (its layer, rule, exceptions, travel), written whole.
 */
export interface ScheduledItemPatch {
  title?: string;
  topicId?: string | null;
  bodyPreview?: string | null;
  startAt?: Date;
  endAt?: Date;
  props?: Record<string, unknown>;
}

/**
 * A travel leg as travel storage writes it (TravelLeg.applyPlan, its reset): a local item of kind
 * `travel`, private to `ownerUserId`, keyed by `props.travelKey`. `travel` is its TravelLegProps
 * (types/travel.ts), written whole.
 */
export interface TravelLegWrite {
  ownerUserId: string;
  title: string;
  topicId: string | null;
  startAt: Date;
  endAt: Date;
  travel: Record<string, unknown>;
}

/** What an upsert of a leg did: made it, changed it (a tombstone made live too), or nothing. */
export type TravelLegUpsertOutcome = 'created' | 'updated' | 'unchanged' | 'refused';

/**
 * When a stored leg may be written over: every condition given must hold of it at the moment of the
 * write (one conditional write, so a change made since it was read can't be overwritten). A stored
 * leg that fails one is left as it is (`refused`).
 */
export interface TravelLegGuard {
  /** Its `updatedAt` is still this: nobody changed it since it was read. */
  unchangedSince?: Date;
  /** It is (true) or is not (false) a leg the member edited by hand (`props.travel.edited`). */
  edited?: boolean;
  /** It is not a skipped tombstone (only Reset brings a skip back). */
  notSkipped?: boolean;
  /** It is not a live leg that started before this (a leg under way or done is history). */
  notStartedBefore?: Date;
}

/** Which of one member's legs (those with a `props.travelKey`) to list. */
export interface TravelLegFilter {
  ownerUserId: string;
  /** Legs that start in [from, to). */
  from?: Date;
  to?: Date;
  ids?: readonly string[];
  /** Tombstones (removed or skipped legs, soft-deleted) too. Default: live legs only. */
  includeRemoved?: boolean;
}

/**
 * What a write-back sets on a mirrored item (plan Addendum A1): the fields its provider confirmed
 * (and, for fields its provider lacks, the values kept here). Never its source, kind, links or
 * overlay.
 */
export interface MirroredItemPatch {
  title?: string;
  status?: ItemStatus;
  statusRaw?: string | null;
  priority?: number | null;
  startAt?: Date | null;
  dueAt?: Date | null;
  endAt?: Date | null;
  allDay?: boolean;
  closedAt?: Date | null;
}

/**
 * One provider record mapped by a sync: every field the sync owns. Fields left out are written as
 * null / empty, so a value cleared at the source is cleared here too. The overlay, visibility,
 * owner and linked items belong to users and are never written.
 */
export interface ItemUpsert {
  /**
   * The id a new copy gets (default: a random one); a stored copy keeps its own. A batch that
   * names its items' container before writing it (a fixture replay) sets it.
   */
  id?: string;
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
  /**
   * createLocal() for each input, in one write, in order, each created a millisecond after the one
   * before it (from `at`, default now), so they list by creation in that order.
   */
  createLocalMany(
    workspaceId: string,
    inputs: readonly CreateLocalItemInput[],
    at?: Date,
  ): Promise<ItemData[]>;
  /**
   * Local to-dos only: a mirrored item throws MirroredItemError (edit it at the source); reserved
   * time (a time block, an area, a travel leg) is not found here (updateScheduled changes it).
   */
  updateLocal(workspaceId: string, id: string, patch: LocalItemPatch): Promise<ItemData | null>;
  /**
   * TodoList's own reserved time of `kind` only (never a to-do, never a mirrored item). With
   * `unchangedSince`, only while the item's `updatedAt` is still that value: a write made on a
   * stale read finds nothing (null), so the caller reads again and retries. Null when there is no
   * such item.
   */
  updateScheduled(
    workspaceId: string,
    id: string,
    kind: ScheduledKind,
    patch: ScheduledItemPatch,
    options?: { unchangedSince?: Date },
  ): Promise<ItemData | null>;
  /**
   * Travel storage's write of one leg, by its key (`props.travelKey`, unique per workspace): a new
   * one is created (kind `travel`, visibility `private`, owned by `leg.ownerUserId`); a stored one
   * (a tombstone too, which is made live again) gets the title, topic, times and `props.travel`
   * given. Writing what is stored already writes nothing (its `updatedAt` stays), so applying one
   * plan twice changes nothing. With a guard, a stored leg is written over only while the guard
   * holds of it (`refused` otherwise, the leg as it is).
   */
  upsertTravelLeg(
    workspaceId: string,
    key: string,
    leg: TravelLegWrite,
    guard?: TravelLegGuard,
  ): Promise<{ item: ItemData; outcome: TravelLegUpsertOutcome }>;
  /** One member's legs, by start then id; live ones only unless `includeRemoved`. */
  listTravelLegs(workspaceId: string, filter: TravelLegFilter): Promise<ItemData[]>;
  /**
   * A live leg becomes a tombstone: `deletedAt` (default now) and `props.travel.removedReason`.
   * The tombstone, or null when there is no such live leg.
   */
  removeTravelLeg(
    workspaceId: string,
    id: string,
    reason: string,
    at?: Date,
  ): Promise<ItemData | null>;
  /**
   * A membership ended: every live leg of the member is soft-deleted, and every one of its legs
   * (its tombstones too) is marked `skipped`, the reason a guarded write (`notSkipped`) never
   * writes over, so a regeneration that raced the leave brings none back. Returns how many live
   * legs it removed.
   */
  removeTravelLegsOf(workspaceId: string, ownerUserId: string, at?: Date): Promise<number>;
  /**
   * A write-back on a live mirrored item of `integrationId` (never a local one): only the fields
   * given change. With `resync`, its `source.hash` is cleared, so the next sync of the record
   * writes every field the provider holds. Null when there is no such item.
   */
  updateMirrored(
    workspaceId: string,
    integrationId: string,
    id: string,
    patch: MirroredItemPatch,
    options: { resync: boolean },
  ): Promise<ItemData | null>;
  /**
   * Only the overlay fields given change (an override given as null is cleared). Works on mirrored
   * and local items.
   */
  setOverlay(workspaceId: string, id: string, overlay: ItemOverlayPatch): Promise<ItemData | null>;
  /**
   * One occurrence of a series disabled (added to `overlay.disabledOccurrences`, kept sorted, the
   * oldest dropped past DISABLED_OCCURRENCES_MAX) or enabled (removed), atomically, with
   * `overlay.editedAt` = `at`. Null when there is no such live item.
   */
  setOccurrenceDisabled(
    workspaceId: string,
    id: string,
    originalStart: string,
    disabled: boolean,
    at: Date,
  ): Promise<ItemData | null>;
  /**
   * A whole Google series disabled or enabled: its master and every exception row of it (one
   * integration's copy) get `overlay.disabled` (true, or null) and lose their one-by-one marks.
   * Returns how many items it changed.
   */
  setSeriesDisabled(
    workspaceId: string,
    series: GoogleSeriesRef,
    disabled: boolean,
    at: Date,
  ): Promise<number>;
  /** The live exception row of a Google series that fills the slot at `originalStart` (ISO). */
  findSeriesException(
    workspaceId: string,
    series: GoogleSeriesRef,
    originalStart: string,
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
   * or unknown (the claim is atomic per to-do and integration), or the item is not a live local
   * to-do (reserved time, a time block or a travel leg, is never copied).
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
   * PERMISSIONS-V2 ruling 6), not deleted, travel legs left out (travel storage removes those):
   * how many. Never their content.
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
  bulkUpsert(
    workspaceId: string,
    docs: readonly ItemUpsert[],
    options?: BulkUpsertOptions,
  ): Promise<ItemBulkUpsertResult>;
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
  /** Whether any item (a deleted one too) belongs to one of these integrations. */
  existsForIntegrations(workspaceId: string, integrationIds: readonly string[]): Promise<boolean>;
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
  /**
   * Files an integration's live items under topics (File under), one write: each assignment moves
   * the items of that container (`null`: the ones with no container) to `topicId`. Only `topicId`
   * is written, never an overlay; items that already have it are not counted. Returns how many.
   */
  refileByContainer(
    workspaceId: string,
    integrationId: string,
    assignments: readonly { containerId: string | null; topicId: string | null }[],
  ): Promise<number>;
  /** Clears one attribute's value on every item of the workspace. Returns how many items held it. */
  clearAttribute(workspaceId: string, key: string): Promise<number>;
  /**
   * Moves the value `from` to `to` of one attribute on every item of the workspace (a renamed
   * select option). Returns how many items held `from`.
   */
  renameAttributeValue(workspaceId: string, key: string, from: string, to: string): Promise<number>;
  /**
   * GLOBAL, every workspace: the purge job (jobs/purge.ts) only. Hard-deletes items
   * soft-deleted before `date`, except a travel leg's tombstone whose leg ended at or after
   * `date`: the day panel shows why a leg went at least through its day, however long the purge
   * waits. Returns how many.
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
