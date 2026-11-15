/**
 * How one caller can edit one item (the item sheet's hints), as an immutable value object: a to-do
 * edits its own fields; a mirrored item's provider fields are its integration's owner's to write
 * back while it is read & write, and the fields its provider lacks are kept here as overrides by
 * any editor who sees it. The integration's mode is told to its owner only. Pure.
 */
import type { IntegrationMode, ItemStatus } from '../../types/domain.js';
import type { WritableField } from '../../types/integrations.js';
import {
  OVERRIDABLE_FIELDS,
  type ItemEditingView,
  type OverridableField,
} from '../../types/items.js';

/** What the hints read of the item's integration. */
export interface EditingIntegration {
  readonly ownerUserId: string;
  readonly mode: IntegrationMode;
  /** Read & write, and writes on for it on this server. */
  readonly allowsWrites: boolean;
  /** Its grant lacks the provider's write scope (read for its owner only). */
  readonly needsReconnect: boolean;
}

/** A mirrored item's side of the hints. */
export interface MirroredEditing {
  /** Its provider's writable fields for its kind. */
  readonly providerFields: readonly WritableField[];
  /** The statuses a write-back can set there. */
  readonly reachableStatuses: readonly ItemStatus[];
  /** Its integration (null: gone). */
  readonly integration: EditingIntegration | null;
  /** Who asks. */
  readonly userId: string;
  /** An event with other guests. */
  readonly needsGuestNotice: boolean;
}

export class ItemEditing {
  readonly #view: Readonly<ItemEditingView>;

  private constructor(view: ItemEditingView) {
    this.#view = Object.freeze(view);
    Object.freeze(this);
  }

  /** A to-do: every field is TodoList's own. */
  static local(): ItemEditing {
    return new ItemEditing({
      origin: 'local',
      providerFields: [],
      overridableFields: [],
      reachableStatuses: [],
      ownsIntegration: false,
      mode: null,
      canWriteProvider: false,
      needsReconnect: false,
      needsGuestNotice: false,
    });
  }

  /** The fields kept here as overrides when the provider takes `providerFields`. */
  static overridable(providerFields: readonly WritableField[]): OverridableField[] {
    return OVERRIDABLE_FIELDS.filter((field) => !providerFields.includes(field));
  }

  /** A mirrored item, for one caller. */
  static mirrored(input: MirroredEditing): ItemEditing {
    const { integration } = input;
    const owns = integration !== null && integration.ownerUserId === input.userId;
    const providerFields = [...input.providerFields];
    return new ItemEditing({
      origin: 'provider',
      providerFields,
      overridableFields: ItemEditing.overridable(providerFields),
      reachableStatuses: providerFields.includes('status') ? [...input.reachableStatuses] : [],
      ownsIntegration: owns,
      mode: owns ? integration.mode : null,
      canWriteProvider:
        owns &&
        providerFields.length > 0 &&
        integration.allowsWrites &&
        !integration.needsReconnect,
      needsReconnect: owns && integration.needsReconnect,
      needsGuestNotice: input.needsGuestNotice,
    });
  }

  get canWriteProvider(): boolean {
    return this.#view.canWriteProvider;
  }

  toView(): ItemEditingView {
    return {
      ...this.#view,
      providerFields: [...this.#view.providerFields],
      overridableFields: [...this.#view.overridableFields],
      reachableStatuses: [...this.#view.reachableStatuses],
    };
  }
}
