/**
 * Items (DATA.md §3.6; docs/design/CLASSES.md §4): one to-do, issue, task, event, assignment,
 * deadline, message or pull request. `Item` is the abstract base, and with `ItemQuery` the only
 * code that reads or writes items.
 *
 * - `Item.from(data)` is the polymorphic factory: a local to-do is a `Todo`; a mirrored item is a
 *   `CalendarEvent`, a `PullRequest` or a `TaskItem` (`MirroredItem`s). Each subclass registers
 *   itself (classes/item/index.ts loads them all), so import the item classes from there.
 * - What an item reads as is its effective value (`override ?? source`, Overrides): its getters,
 *   its views and every query (ItemQuery projects it).
 * - Every change starts from an item the caller may see (ItemPolicy: share-on-attach), found by
 *   `Item.find`: anything else is a 404. `edit` is polymorphic: a to-do changes its own fields, a
 *   mirrored item splits the edit between its provider and its overrides. `setOverlay` is the same
 *   for every item: TodoList's own fields, never written to a provider.
 */
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, SoftDeletable, Viewable } from '../base/contracts.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { ItemPolicy, type ItemFacts } from '../policies/ItemPolicy.js';
import { Topic } from '../workspace/Topic.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import type { ItemData, ItemOverlayPatch } from '../../models/definitions/Item.js';
import { getItemRepository } from '../../models/index.js';
import { scrub } from '../../services/scrub.js';
import { redactString } from '../../services/secretPatterns.js';
import type { ItemKind, ItemStatus, Provider, Visibility } from '../../types/domain.js';
import type { ItemDetail, ItemSummary } from '../../types/items.js';
import { Copies, type LiveStatuses } from './Copies.js';
import type { ItemEdit } from './ItemEdit.js';
import type { ItemEditing } from './ItemEditing.js';
import { itemDataOf } from './itemRecord.js';
import { Overlay, type OverlayEdit } from './Overlay.js';
import type { OverridableValues } from './Overrides.js';

/** Which class stands for a stored item. */
export type ItemClassName = 'todo' | 'task' | 'pr' | 'event';

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

  /** Which class a stored item is: a local to-do, or a mirrored event, pull request or task. */
  static classOf(data: Pick<ItemData, 'kind' | 'source'>): ItemClassName {
    if (data.source.provider === 'local') return 'todo';
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

  /** An aggregation's row (itemRecord.ts) as its class. */
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

  // ─── What every item is ───────────────────────────────────────────────────

  /** A local to-do (TodoList's own), or mirrored from a provider. */
  abstract readonly isLocal: boolean;

  get kind(): ItemKind {
    return this.data.kind;
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
    const { workspaceId, integrationId, ownerUserId, visibility, topicId, deletedAt, source } =
      this.data;
    return {
      workspaceId,
      integrationId,
      ownerUserId,
      visibility,
      topicId,
      deletedAt,
      source: { provider: source.provider, url: source.url },
    };
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
    };
  }

  // ─── Changes ──────────────────────────────────────────────────────────────

  /**
   * One edit (`PATCH …/items/:id`), polymorphic: a to-do changes its own fields; a mirrored item
   * splits it between its provider and its overrides. The item as now stored.
   */
  abstract edit(caller: Caller, edit: ItemEdit): Promise<Item>;

  /**
   * TodoList's own fields on any item the caller sees (editors): pin, note, hidden, a topic to
   * file it under (one of the workspace's: 400 otherwise), calendar sync, a planned date, custom
   * attribute values. Never written to a provider. The item as now stored.
   */
  async setOverlay(caller: Caller, edit: OverlayEdit): Promise<Item> {
    this.assertIn(caller);
    caller.require('editor');
    if (edit.topicOverride !== undefined && edit.topicOverride !== null) {
      await Topic.assertOf(this.workspaceId, edit.topicOverride);
    }
    return this.storeOverlay(Overlay.patch(edit, caller.settings));
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
