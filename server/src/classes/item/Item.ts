/**
 * Items (DATA.md §3.6; docs/design/CLASSES.md §4): one to-do, issue, task, event, assignment,
 * deadline, message or pull request. `Item` is the abstract base, and with `ItemQuery` the only
 * code that reads or writes items.
 *
 * - `Item.from(data)` is the polymorphic factory: a local to-do is a `Todo`; TodoList's own
 *   reserved time is a `ScheduledItem` (a `TimeBlock`, a `TimeArea` or a `TravelLeg`, by kind and
 *   layer), never a `Todo`; a mirrored item is a `CalendarEvent`, a `PullRequest` or a `TaskItem`
 *   (`MirroredItem`s). Each subclass registers itself (classes/item/index.ts loads them all), so
 *   import the item classes from there.
 * - What an item reads as is its effective value (`override ?? source`, Overrides): its getters,
 *   its views and every query (ItemQuery projects it).
 * - Every change starts from an item the caller may see (ItemPolicy: share-on-attach), found by
 *   `Item.find`: anything else is a 404. `edit` is polymorphic: a to-do changes its own fields, a
 *   mirrored item splits the edit between its provider and its overrides. `setOverlay` is the same
 *   for every item: TodoList's own fields, never written to a provider; so is `setDisabled`
 *   (Disabled.ts), polymorphic over a series.
 */
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, SoftDeletable, Viewable } from '../base/contracts.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { ItemPolicy, type ItemFacts } from '../policies/ItemPolicy.js';
import { AttributeDefinitions } from '../workspace/AttributeDefinitions.js';
import { Topic } from '../workspace/Topic.js';
import { MirroredItemError } from '../../errors/MirroredItemError.js';
import { NotCompletableError } from '../../errors/NotCompletableError.js';
import { NotDeletableError } from '../../errors/NotDeletableError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import type { ItemData, ItemOverlayPatch } from '../../models/definitions/Item.js';
import { getItemRepository } from '../../models/index.js';
import { scrub } from '../../services/scrub.js';
import { redactString } from '../../services/secretPatterns.js';
import type { ItemKind, ItemStatus, Provider, Visibility } from '../../types/domain.js';
import type { ItemDetail, ItemSummary } from '../../types/items.js';
import { layerOf } from '../../types/scheduled.js';
import { AttributeValues } from './AttributeValues.js';
import { isCompletable, isDeletable, type Completable, type Deletable } from './contracts.js';
import { Copies, type LiveStatuses } from './Copies.js';
import { DisabledState, type DisableChange } from './Disabled.js';
import { ItemChanges } from './ItemChanges.js';
import { DueDate } from './DueDate.js';
import type { ItemEdit, ProviderHalf } from './ItemEdit.js';
import type { ItemEditing } from './ItemEditing.js';
import { itemDataOf } from './itemRecord.js';
import { Overlay, type OverlayEdit } from './Overlay.js';
import type { OverridableValues } from './Overrides.js';

/** Which class stands for a stored item. */
export type ItemClassName = 'todo' | 'task' | 'pr' | 'event' | 'block' | 'area' | 'travel';

/** Makes one subclass from stored data (its constructor, wrapped). */
export type ItemFactory = (data: ItemData) => Item;

/** What a view adds to the item: its copies' provider statuses, its editing hints. */
export interface ItemViewContext {
  readonly liveStatuses?: LiveStatuses;
  readonly editing?: ItemEditing;
}

function redacted(value: string | null): string | null {
  return value === null ? null : redactString(value);
}

export abstract class Item
  extends WorkspaceEntity<ItemData>
  implements Viewable<ItemDetail>, Auditable, SoftDeletable
{
  static readonly #factories = new Map<ItemClassName, ItemFactory>();

  protected constructor(data: ItemData) {
    super(data);
  }

  // ─── The factory ──────────────────────────────────────────────────────────

  /** A subclass, under its name (its module calls this once as it loads). */
  static register(name: ItemClassName, factory: ItemFactory): void {
    Item.#factories.set(name, factory);
  }

  /**
   * Which class a stored item is. A local item is a travel leg (kind `travel`), an area (kind
   * `block` with `props.layer: 'area'`), a time block (any other `block`) or else a to-do. A
   * mirrored item is an event, a pull request or a task.
   */
  static classOf(data: Pick<ItemData, 'kind' | 'source' | 'props'>): ItemClassName {
    if (data.source.provider === 'local') {
      if (data.kind === 'travel') return 'travel';
      if (data.kind === 'block') return layerOf(data) === 'area' ? 'area' : 'block';
      return 'todo';
    }
    if (data.kind === 'event') return 'event';
    if (data.kind === 'pr') return 'pr';
    return 'task';
  }

  /** The item's class made from stored data. */
  static from(data: ItemData): Item {
    const name = Item.classOf(data);
    const factory = Item.#factories.get(name);
    if (factory === undefined) {
      throw new Error(
        `The item class "${name}" is not registered: import the item classes from classes/item/index.js`,
      );
    }
    return factory(data);
  }

  /**
   * An aggregation's row (itemRecord.ts) as its class. A row read after the effective projection
   * (ItemQuery's lists) holds effective values in its own fields: such an item is for views only
   * (its getters read the same), never for an edit, which compares with what the provider sent
   * (an edit starts from `Item.find`, which reads the stored row).
   */
  static fromDoc(doc: Readonly<Record<string, unknown>>): Item {
    return Item.from(itemDataOf(doc));
  }

  // ─── Reads ────────────────────────────────────────────────────────────────

  /**
   * The item the caller may see (ItemPolicy, share-on-attach; a provider copy too: a read of one
   * item by id is not absorbed), as stored; 404 for anything else.
   */
  static async find(caller: Caller, id: string): Promise<Item> {
    const policy = await ItemPolicy.for(caller);
    const [doc] = await (
      await getItemRepository()
    ).aggregate(caller.workspaceId, [
      { $match: { ...policy.itemFilterUnabsorbed(caller.context), _id: id } },
      { $limit: 1 },
    ]);
    if (doc === undefined) throw new NotFoundError();
    return Item.fromDoc(doc);
  }

  /**
   * A topic was deleted: its items, deleted ones included, become Unsorted and overlays filing an
   * item under it are cleared (Topic.delete). Returns how many items.
   */
  static async unsetTopicIn(workspaceId: string, topicId: string): Promise<number> {
    return (await getItemRepository()).unsetTopic(workspaceId, topicId);
  }

  /** How many live items an integration has (the demo data's summary). */
  static async countLiveOf(workspaceId: string, integrationId: string): Promise<number> {
    return Item.countLive(workspaceId, { integrationId });
  }

  /** countLiveOf of each of these integrations, in one read. */
  static async countLiveOfEach(
    workspaceId: string,
    integrationIds: readonly string[],
  ): Promise<Map<string, number>> {
    const counts = new Map(integrationIds.map((id) => [id, 0]));
    if (integrationIds.length === 0) return counts;
    const rows = await (
      await getItemRepository()
    ).aggregate<{ _id: unknown; n: number }>(workspaceId, [
      { $match: { integrationId: { $in: [...integrationIds] }, deletedAt: null } },
      { $group: { _id: '$integrationId', n: { $sum: 1 } } },
    ]);
    for (const { _id, n } of rows) if (typeof _id === 'string') counts.set(_id, n);
    return counts;
  }

  /** How many live items match a stored-field filter (internal: the counts above build it). */
  protected static async countLive(
    workspaceId: string,
    match: Readonly<Record<string, unknown>>,
  ): Promise<number> {
    const [row] = await (
      await getItemRepository()
    ).aggregate<{ n: number }>(workspaceId, [
      { $match: { ...match, deletedAt: null } },
      { $count: 'n' },
    ]);
    return row?.n ?? 0;
  }

  // ─── What every item is ───────────────────────────────────────────────────

  /** TodoList's own (a to-do, a time block, a travel leg), or mirrored from a provider. */
  abstract readonly isLocal: boolean;

  get kind(): ItemKind {
    return this.data.kind;
  }

  /** The title the provider (or its creator) gave it, whatever his own override says. */
  get providerTitle(): string {
    return this.data.title;
  }

  /** The source values the overrides may stand in for. */
  protected get sourceValues(): OverridableValues {
    const { title, status, dueAt, allDay, startAt, priority } = this.data;
    return { title, status, dueAt, allDay, startAt, priority };
  }

  /** What it reads as: each override where set, else the source value. */
  get effective(): OverridableValues {
    return this.overlay.overrides.effective(this.sourceValues);
  }

  get title(): string {
    return this.effective.title;
  }

  get status(): ItemStatus {
    return this.effective.status;
  }

  get priority(): number | null {
    return this.effective.priority;
  }

  get dueAt(): Date | null {
    return this.effective.dueAt;
  }

  get allDay(): boolean {
    return this.effective.allDay;
  }

  /** Its effective due date as a value (HasDueDate): null when it has none. */
  get due(): DueDate | null {
    const { dueAt, allDay } = this.effective;
    return DueDate.from(dueAt, allDay);
  }

  get startAt(): Date | null {
    return this.effective.startAt;
  }

  get endAt(): Date | null {
    return this.data.endAt;
  }

  get topicId(): string | null {
    return this.data.topicId;
  }

  get containerId(): string | null {
    return this.data.containerId;
  }

  /** Where it happens, as its location text says (trimmed); null when it has none. */
  get location(): string | null {
    const location = this.data.props['location'];
    if (typeof location !== 'string') return null;
    const trimmed = location.trim();
    return trimmed === '' ? null : trimmed;
  }

  get ownerUserId(): string | null {
    return this.data.ownerUserId;
  }

  get visibility(): Visibility {
    return this.data.visibility;
  }

  get provider(): Provider {
    return this.data.source.provider;
  }

  /** Where it is opened: its provider page (an app link for a local to-do). */
  get sourceUrl(): string {
    return this.data.source.url;
  }

  get overlay(): Overlay {
    return Overlay.of(this.data.overlay);
  }

  /** Its custom attribute values (kept in its overlay). */
  get attributes(): AttributeValues {
    return this.overlay.attributes;
  }

  get copies(): Copies {
    return Copies.of(this.data.copies);
  }

  get deletedAt(): Date | null {
    return this.data.deletedAt;
  }

  get isDeleted(): boolean {
    return this.data.deletedAt !== null;
  }

  /** What ItemPolicy reads of it. */
  get facts(): ItemFacts {
    const {
      workspaceId,
      integrationId,
      ownerUserId,
      visibility,
      topicId,
      deletedAt,
      source,
      kind,
    } = this.data;
    return {
      workspaceId,
      integrationId,
      ownerUserId,
      visibility,
      topicId,
      deletedAt,
      source: { provider: source.provider, url: source.url },
      kind,
    };
  }

  /**
   * This item, to complete (`POST …/complete`, MCP `complete_todo`): a mirrored item is completed
   * at its source (the mirrored 409 with its link); scheduled time has no status (409
   * `not_completable`).
   */
  completable(): Item & Completable<Item> {
    if (!this.isLocal) throw new MirroredItemError(this.provider, this.sourceUrl);
    if (!isCompletable(this)) throw new NotCompletableError();
    return this;
  }

  /**
   * This item, to delete (`DELETE …/items/:id`, MCP `delete_todo`): a mirrored item is deleted at
   * its source (the mirrored 409 with its link); a travel leg is skipped, never deleted (409
   * `not_deletable`).
   */
  deletable(): Item & Deletable {
    if (!this.isLocal) throw new MirroredItemError(this.provider, this.sourceUrl);
    if (!isDeletable(this)) throw new NotDeletableError();
    return this;
  }

  /** Whether the caller may see it (ItemPolicy). */
  isVisibleTo(caller: Caller, policy: ItemPolicy): boolean {
    return policy.canRead(caller, this.facts);
  }

  auditTarget(): AuditTarget {
    return AuditTarget.of('item', this.id);
  }

  /** How `caller` can edit it (the item sheet's hints). */
  abstract editing(caller: Caller): Promise<ItemEditing>;

  /** Its hints without asking anyone (a to-do's; a mirrored item's as nobody's). */
  protected abstract get defaultEditing(): ItemEditing;

  // ─── Views ────────────────────────────────────────────────────────────────

  /** As lists show it (MCP.md §7.6): effective values, text redacted. */
  toSummary(context: ItemViewContext = {}): ItemSummary {
    const { source } = this.data;
    const effective = this.effective;
    return {
      id: this.id,
      kind: this.kind,
      topicId: this.topicId,
      title: redactString(effective.title),
      bodyPreview: redacted(this.data.bodyPreview),
      status: effective.status,
      priority: effective.priority,
      startAt: effective.startAt,
      dueAt: effective.dueAt,
      endAt: this.data.endAt,
      containerId: this.containerId,
      source: {
        provider: source.provider,
        externalId: source.externalId,
        key: source.key,
        url: source.url,
      },
      openIn: { provider: source.provider, url: source.url },
      props: { ...(scrub(this.data.props) as Record<string, unknown>) },
      overlay: this.overlay.toView(),
      copies: this.copies.views(this.id, context.liveStatuses),
      lastSeenAt: this.data.lastSeenAt,
    };
  }

  /** The full item. */
  toView(_caller?: Caller, context: ItemViewContext = {}): ItemDetail {
    const data = this.data;
    return {
      ...this.toSummary(context),
      integrationId: data.integrationId,
      statusRaw: redacted(data.statusRaw),
      allDay: this.allDay,
      assignees: [...data.assignees],
      labels: data.labels.map(redactString),
      parentId: data.parentId,
      ownerUserId: data.ownerUserId,
      visibility: data.visibility === 'private' ? 'private' : 'workspace',
      closedAt: data.closedAt,
      createdAt: data.createdAt,
      updatedAt: data.updatedAt,
      editing: (context.editing ?? this.defaultEditing).toView(),
      sourceValues: this.isLocal
        ? null
        : { ...this.sourceValues, title: redactString(this.sourceValues.title) },
    };
  }

  // ─── Changes ──────────────────────────────────────────────────────────────

  /**
   * One edit (`PATCH …/items/:id`), polymorphic: a to-do changes its own fields; a mirrored item
   * splits it between its provider and its overrides. The item as now stored.
   */
  abstract edit(caller: Caller, edit: ItemEdit): Promise<Item>;

  /**
   * The fields `edit` would change at the item's provider, with its checks run and nothing written
   * (a caller asking for a confirmation first: MCP). None for a to-do.
   */
  abstract providerChanges(caller: Caller, edit: ItemEdit): Promise<ProviderHalf>;

  /**
   * TodoList's own fields on any item the caller sees (editors): pin, note, hidden, a topic to
   * file it under (one of the workspace's: 400 otherwise), calendar sync, a planned date, custom
   * attribute values. Never written to a provider. The item as now stored.
   */
  async setOverlay(caller: Caller, edit: OverlayEdit): Promise<Item> {
    this.assertIn(caller);
    (await ItemPolicy.for(caller)).assertCanOverride(caller, this.facts);
    if (edit.topicOverride !== undefined && edit.topicOverride !== null) {
      await Topic.assertOf(this.workspaceId, edit.topicOverride);
    }
    return this.storeOverlay(Overlay.patch(edit, caller.settings));
  }

  /**
   * Custom attribute values on any item the caller sees (editors), each checked against the
   * workspace's definitions (AttributeValues: 400 for an unknown key or a value that does not
   * fit); null clears one. Never written to a provider. The item as now stored.
   */
  async setAttributes(
    caller: Caller,
    values: Readonly<Record<string, unknown>>,
    now: Date = new Date(),
  ): Promise<Item> {
    this.assertIn(caller);
    (await ItemPolicy.for(caller)).assertCanOverride(caller, this.facts);
    const checked = AttributeValues.checked(values, AttributeDefinitions.of(caller.settings));
    return this.storeOverlay({ attrs: checked.toStored(), editedAt: now });
  }

  /**
   * Disables the item, or occurrences of its series, or enables them again (editors who see it;
   * Disabled.ts): TodoList's own state, never written to a provider. Polymorphic: a single item
   * changes as a whole; a repeating time block or area, and a Google series, by `change.scope`; a
   * travel leg refuses (it is skipped). The item as now stored.
   */
  async setDisabled(caller: Caller, change: DisableChange, now: Date = new Date()): Promise<Item> {
    this.assertIn(caller);
    (await ItemPolicy.for(caller)).assertCanOverride(caller, this.facts);
    const updated = await this.applyDisabled(caller, change, now);
    // Travel hears of it: a disabled occurrence anchors no trip (ItemChanges).
    await ItemChanges.notify(caller, {
      itemId: this.id,
      kind: this.kind,
      before: this.data,
      after: updated.data,
    });
    return updated;
  }

  /** A single item: the whole of it (a scope or an occurrence names nothing more). */
  protected applyDisabled(_caller: Caller, change: DisableChange, now: Date): Promise<Item> {
    return this.storeOverlay({ disabled: change.disabled ? true : null, editedAt: now });
  }

  /** One occurrence of its series, by original start, disabled or enabled (the item as now stored). */
  protected async storeDisabledOccurrence(
    originalStart: Date,
    disabled: boolean,
    now: Date,
  ): Promise<Item> {
    const updated = await (
      await getItemRepository()
    ).setOccurrenceDisabled(
      this.workspaceId,
      this.id,
      DisabledState.key(originalStart),
      disabled,
      now,
    );
    if (updated === null) throw new NotFoundError();
    return Item.from(updated);
  }

  /** Stores an overlay patch; the item as now stored (404 when it is gone). */
  protected async storeOverlay(patch: ItemOverlayPatch): Promise<Item> {
    const updated = await (await getItemRepository()).setOverlay(this.workspaceId, this.id, patch);
    if (updated === null) throw new NotFoundError();
    return Item.from(updated);
  }

  /** The item as stored now (404 when it is gone). */
  protected async reload(): Promise<Item> {
    const stored = await (await getItemRepository()).findById(this.workspaceId, this.id);
    if (stored === null) throw new NotFoundError();
    return Item.from(stored);
  }
}
