/**
 * An item mirrored from a provider (ProviderLinked): the sync owns its source fields. One edit is
 * split (plan Addendum A1, Phase 4a), a template method:
 * 1. the item must be one the caller sees (404), and they an editor (403);
 * 2. split against its provider's writable fields for its kind (ItemEdit#split): a field the
 *    provider takes is for the provider; a field it lacks (title, status, due date, start,
 *    priority) is kept here as an override; anything else is edited at its source, and the whole
 *    edit is refused (409 `{message, openIn}`, as before);
 * 3. a provider field set to what the item already has is dropped, and so is an override equal to
 *    the provider's value (it clears the override);
 * 4. what is left for the provider is its integration's owner's to write (403
 *    `integration_not_owner` for anyone else), through the integration's own write-back
 *    (`writeBack`: TaskProvider#updateTask, CalendarProvider#updateEvent), which refuses a
 *    read-only integration (409 `integration_read_only`) before anything is sent; a written field
 *    loses its override;
 * 5. then the overrides are stored (never touched by a sync).
 * An edit with nothing for the provider never reaches the integration, so it works while it is
 * read-only and for any editor who sees the item.
 */
import type { Caller } from '../base/Caller.js';
import { Integration } from '../integration/index.js';
import { definitionOf } from '../integration/definitions/index.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { TopicRules } from '../workspace/TopicRules.js';
import { IntegrationNotOwnerError } from '../../errors/IntegrationNotOwnerError.js';
import { MirroredItemError } from '../../errors/MirroredItemError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ProviderPartialWriteError } from '../../errors/ProviderPartialWriteError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { ItemData, ItemOverrides, ItemUpsert } from '../../models/definitions/Item.js';
import { getItemRepository } from '../../models/index.js';
import { itemSourceHash } from '../../sync/hash.js';
import { itemProblem } from '../../sync/recordCheck.js';
import type { MappedItem } from '../../sync/types.js';
import type { ItemStatus, Provider } from '../../types/domain.js';
import type { WritableField } from '../../types/integrations.js';
import type { OverridableField } from '../../types/items.js';
import { Container } from './Container.js';
import type { ProviderLinked } from './contracts.js';
import { Item } from './Item.js';
import type { ItemEdit, ProviderHalf } from './ItemEdit.js';
import { ItemEditing, type EditingIntegration } from './ItemEditing.js';
import { Overrides, type OverridesPatch } from './Overrides.js';

/** The sync resource a created item is kept under (its provider's; Google: its calendar's). */
const RESOURCES: Readonly<Record<string, string>> = {
  jira: 'issues',
  linear: 'issues',
  github: 'issues',
  clickup: 'tasks',
};

function syncResourceOf(integration: IntegrationData, mapped: MappedItem): string | null {
  if (integration.provider === 'google_calendar') {
    return mapped.containerExternalId === undefined || mapped.containerExternalId === null
      ? null
      : `calendar:${mapped.containerExternalId}`;
  }
  return RESOURCES[integration.provider] ?? null;
}

const sameInstant = (a: Date | null, b: Date | null): boolean =>
  a === null || b === null ? a === b : a.getTime() === b.getTime();

type MutableHalf = { -readonly [K in keyof ProviderHalf]: ProviderHalf[K] };
type MutableOverrides = { -readonly [K in keyof ItemOverrides]?: ItemOverrides[K] };

export abstract class MirroredItem extends Item implements ProviderLinked {
  readonly isLocal = false;

  get integrationId(): string {
    return this.data.integrationId ?? '';
  }

  get openIn(): { provider: Provider; url: string } {
    return { provider: this.data.source.provider, url: this.data.source.url };
  }

  /** The fields its provider takes for its kind (its definition's `writableFields`). */
  get providerFields(): readonly WritableField[] {
    return definitionOf(this.provider)?.writableFieldsFor(this.kind) ?? [];
  }

  /** The fields kept here as overrides: those its provider lacks for its kind. */
  get overridableFields(): OverridableField[] {
    return ItemEditing.overridable(this.providerFields);
  }

  /** The statuses a write-back can set at its provider. */
  get reachableStatuses(): readonly ItemStatus[] {
    return definitionOf(this.provider)?.reachableStatuses ?? [];
  }

  /** Whether an edit must say if its other guests hear of it (an event with guests). */
  protected needsGuestNotice(): boolean {
    return false;
  }

  /** The hints for `caller`: its integration's owner and mode read now (the mode: owner only). */
  async editing(caller: Caller): Promise<ItemEditing> {
    const integration = await Integration.forWorker(this.integrationId);
    const facts: EditingIntegration | null =
      integration?.workspaceId === this.workspaceId
        ? {
            ownerUserId: integration.ownerUserId,
            mode: integration.mode.name,
            allowsWrites: integration.allowsWrites,
            // Its grant's scopes are its owner's to know (credential metadata: nothing opened).
            needsReconnect:
              integration.isOwnedBy(caller.userId) && (await integration.needsWriteConsent()),
          }
        : null;
    return this.#editing(caller.userId, facts);
  }

  protected get defaultEditing(): ItemEditing {
    return this.#editing('', null);
  }

  #editing(userId: string, integration: EditingIntegration | null): ItemEditing {
    return ItemEditing.mirrored({
      providerFields: this.providerFields,
      reachableStatuses: this.reachableStatuses,
      integration,
      userId,
      needsGuestNotice: this.needsGuestNotice(),
    });
  }

  // ─── The edit ─────────────────────────────────────────────────────────────

  async edit(caller: Caller, edit: ItemEdit): Promise<Item> {
    // 1–3. Checked and split; nothing written yet.
    const { provider, overrides } = await this.#plan(caller, edit);
    // 4. The provider's half: its owner's, through the integration's write-back.
    const written = Object.keys(provider);
    if (written.length > 0) {
      const integration = await this.#ownIntegration(caller);
      try {
        await this.writeBack(caller, integration, provider, edit.notifyGuests);
      } catch (error) {
        // Part of it reached the provider (and is kept): the local half is kept too, then the
        // caller is told. A refusal or no answer wrote nothing, so nothing is kept.
        if (error instanceof ProviderPartialWriteError) {
          this.#clearStale(overrides, error.written);
          if (Object.keys(overrides).length > 0) {
            await this.storeOverlay({ overrides, editedAt: new Date() });
          }
        }
        throw error;
      }
      this.#clearStale(overrides, written);
    }
    // 5. The local half.
    if (Object.keys(overrides).length === 0) return this.reload();
    return this.storeOverlay({ overrides, editedAt: new Date() });
  }

  /** The provider fields the edit would change (nothing written; its checks run). */
  async providerChanges(caller: Caller, edit: ItemEdit): Promise<ProviderHalf> {
    return (await this.#plan(caller, edit)).provider;
  }

  /**
   * The edit, checked and split, with nothing written: the caller keeps TodoList's own fields of
   * an item they see (ItemPolicy#canOverride: 404, else 403); a field edited at its source only is
   * the mirrored 409; an `allDay` kept here belongs to a due date of an item without a start (an
   * item with a start keeps its own form: 400). Then what changes: a provider field set to what the
   * provider has is dropped (and clears a stale override of it), an override equal to the
   * provider's value clears it.
   */
  async #plan(
    caller: Caller,
    edit: ItemEdit,
  ): Promise<{ provider: ProviderHalf; overrides: MutableOverrides }> {
    this.assertIn(caller);
    (await ItemPolicy.for(caller)).assertCanOverride(caller, this.facts);
    const split = edit.split(this.providerFields);
    if (split.refused.length > 0) throw new MirroredItemError(this.provider, this.data.source.url);
    if (typeof split.overrides.allDay === 'boolean' && this.#hasStart(split.overrides)) {
      throw new ValidationError(
        'allDay: an item with a start keeps its own; change its time instead',
      );
    }
    const provider = this.changedFields(split.provider);
    const overrides = this.#effectiveOverrides(split.overrides);
    this.#clearStale(
      overrides,
      Object.keys(split.provider).filter((field) => !(field in provider)),
    );
    return { provider, overrides };
  }

  /** Whether it has a start once the edit's overrides apply (an event always keeps its time). */
  #hasStart(overrides: OverridesPatch): boolean {
    if (this.keepsOwnTime()) return true;
    const start =
      overrides.startAt === undefined
        ? (this.overlay.overrides.get('startAt') ?? this.data.startAt)
        : (overrides.startAt ?? this.data.startAt);
    return start !== null;
  }

  /** An item whose time is its provider's alone (a calendar event). */
  protected keepsOwnTime(): boolean {
    return false;
  }

  /** The overrides of `fields` cleared in `overrides`, where one is set (the provider's value wins). */
  #clearStale(overrides: MutableOverrides, fields: readonly string[]): void {
    for (const [field, value] of Object.entries(Overrides.clearing(fields))) {
      if (this.overlay.overrides.get(field as keyof ItemOverrides) !== null) {
        Object.assign(overrides, { [field]: value });
      }
    }
  }

  /**
   * The provider fields that change: one set to what the item has is dropped. An event compares
   * its time as a whole (CalendarEvent).
   */
  protected changedFields(half: ProviderHalf): ProviderHalf {
    const data = this.data;
    const changed: MutableHalf = {};
    if (half.title !== undefined && half.title !== data.title) changed.title = half.title;
    if (half.status !== undefined && half.status !== data.status) changed.status = half.status;
    if (half.dueAt !== undefined) {
      const allDay = half.allDay ?? data.allDay;
      const same =
        half.dueAt === null
          ? data.dueAt === null
          : sameInstant(half.dueAt, data.dueAt) && allDay === data.allDay;
      if (!same) {
        changed.dueAt = half.dueAt;
        if (half.allDay !== undefined) changed.allDay = half.allDay;
      }
    }
    if (half.startAt !== undefined && !sameInstant(half.startAt, data.startAt)) {
      changed.startAt = half.startAt;
    }
    if (half.endAt !== undefined && !sameInstant(half.endAt, data.endAt)) {
      changed.endAt = half.endAt;
    }
    if (half.priority !== undefined && half.priority !== data.priority) {
      changed.priority = half.priority;
    }
    return changed;
  }

  /**
   * Sends the provider half through the item's integration (its owner's, checked): the
   * integration validates it, refuses a read-only integration before anything is sent, writes,
   * audits and saves what the provider confirmed.
   */
  protected abstract writeBack(
    caller: Caller,
    integration: Integration,
    half: ProviderHalf,
    notifyGuests: boolean | undefined,
  ): Promise<void>;

  /** The item's integration, when the caller owns it (403 `integration_not_owner` otherwise). */
  async #ownIntegration(caller: Caller): Promise<Integration> {
    const integration = await Integration.forWorker(this.integrationId);
    if (integration?.workspaceId !== this.workspaceId) throw new NotFoundError();
    if (!integration.isOwnedBy(caller.userId)) throw new IntegrationNotOwnerError(integration.id);
    return integration;
  }

  /** The overrides an edit sets: one equal to the provider's value clears it (null). */
  #effectiveOverrides(given: OverridesPatch): MutableOverrides {
    const source = this.data;
    const patch: MutableOverrides = {};
    if (given.title !== undefined) {
      patch.title = given.title === source.title ? null : given.title;
    }
    if (given.status !== undefined) {
      patch.status = given.status === source.status ? null : given.status;
    }
    if (given.priority !== undefined) {
      patch.priority = given.priority === source.priority ? null : given.priority;
    }
    if (given.startAt !== undefined) {
      patch.startAt = sameInstant(given.startAt, source.startAt) ? null : given.startAt;
    }
    if (given.dueAt !== undefined) {
      const allDay = given.allDay ?? null;
      const same =
        given.dueAt === null ||
        (sameInstant(given.dueAt, source.dueAt) && (allDay ?? source.allDay) === source.allDay);
      patch.dueAt = same ? null : given.dueAt;
      patch.allDay = same || allDay === source.allDay ? null : allDay;
    }
    return patch;
  }

  // ─── H5: a created item stored at once ────────────────────────────────────

  /**
   * "One row, not three" (H5): an item just created at the provider, as its sync maps it, stored
   * through the same upsert the sync uses (by natural key, with the same record checks and source
   * hash), so it exists at once. Its sync resource is its provider's, so a later full sync keeps it
   * only when the integration's scope includes it, and takes it over, overlay untouched. Null when
   * it fails the record checks.
   */
  static async store(
    integration: IntegrationData,
    mapped: MappedItem,
  ): Promise<MirroredItem | null> {
    if (
      itemProblem(mapped) !== null ||
      mapped.source.externalId === '' ||
      mapped.source.url === ''
    ) {
      return null;
    }
    const { workspaceId } = integration;
    const container =
      mapped.containerExternalId === undefined || mapped.containerExternalId === null
        ? null
        : await Container.findByExternalId(workspaceId, integration.id, mapped.containerExternalId);
    const upsert: ItemUpsert = {
      integrationId: integration.id,
      containerId: container?.id ?? null,
      kind: mapped.kind,
      topicId:
        mapped.topicId !== undefined
          ? mapped.topicId
          : container !== null
            ? container.topicId
            : TopicRules.defaultFor(integration),
      title: mapped.title,
      bodyPreview: mapped.bodyPreview ?? null,
      status: mapped.status,
      statusRaw: mapped.statusRaw ?? null,
      priority: mapped.priority ?? null,
      startAt: mapped.startAt ?? null,
      dueAt: mapped.dueAt ?? null,
      endAt: mapped.endAt ?? null,
      allDay: mapped.allDay ?? false,
      assignees: mapped.assignees ?? [],
      labels: mapped.labels ?? [],
      props: mapped.props ?? {},
      closedAt: mapped.closedAt ?? null,
      deletedAt: null,
      source: {
        ...mapped.source,
        provider: integration.provider,
        accountId: integration.accountId,
      },
      // The resource a sync lists it under: a later full sync keeps it only if its scope includes
      // it, like every item of the integration (the copy is never kept by us alone).
      syncResource: syncResourceOf(integration, mapped),
    };
    const withHash: ItemUpsert = {
      ...upsert,
      source: { ...upsert.source, hash: itemSourceHash(upsert) },
    };
    const items = await getItemRepository();
    await items.bulkUpsert(workspaceId, [withHash]);
    const stored = await items.findBySource(
      workspaceId,
      {
        provider: integration.provider,
        accountId: integration.accountId,
        integrationId: integration.id,
      },
      mapped.source.externalId,
    );
    if (stored === null) return null;
    const item = Item.from(stored);
    return item instanceof MirroredItem ? item : null;
  }

  /** The integration's live item with this external id (a created one, stored), or null. */
  static async findStored(
    integration: IntegrationData,
    externalId: string,
  ): Promise<MirroredItem | null> {
    const stored = await (
      await getItemRepository()
    ).findBySource(
      integration.workspaceId,
      {
        provider: integration.provider,
        accountId: integration.accountId,
        integrationId: integration.id,
      },
      externalId,
    );
    if (stored === null) return null;
    const item = Item.from(stored);
    return item instanceof MirroredItem ? item : null;
  }

  /** The provider's id of this item. */
  get externalId(): string {
    return this.data.source.externalId;
  }

  /**
   * Marks it as the provider copy of a local to-do (H5): whoever sees that to-do sees the copy on
   * the to-do's row instead (copyAbsorptionFilter).
   */
  async markAsCopyOf(todo: Pick<ItemData, 'id' | 'ownerUserId' | 'visibility'>): Promise<void> {
    await this.storeOverlay({
      copyOf: todo.id,
      copyOfOwner: todo.ownerUserId,
      copyOfShared: todo.visibility === 'workspace',
    });
  }
}
