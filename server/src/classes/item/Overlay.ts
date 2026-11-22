/**
 * An item's overlay, as an immutable value object: what users keep on any item, mirrored or local,
 * that the sync never touches and no provider ever receives: pin, note, hidden, a topic to file it
 * under, whether the workspace calendar takes it, a planned date, custom attribute values, whether
 * it is disabled (Disabled.ts), and (on a mirrored item) its overrides. It also carries H5's copy marks (`copyOf`…), which only the copy
 * flow sets.
 *
 * `patch()` turns an overlay edit into what is stored: the planned date parsed (PlannedAt), the
 * attribute values checked against the workspace's definitions (AttributeValues), `editedAt`
 * stamped. Pure.
 */
import type { ItemOverlay, ItemOverlayPatch } from '../../models/definitions/Item.js';
import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import type { ItemOverlayView, UpdateOverlayRequestBody } from '../../types/items.js';
import { redactString } from '../../services/secretPatterns.js';
import { AttributeDefinitions } from '../workspace/AttributeDefinitions.js';
import { AttributeValues } from './AttributeValues.js';
import { DisabledState } from './Disabled.js';
import { Overrides } from './Overrides.js';
import { PlannedAt } from './PlannedAt.js';

/**
 * An overlay edit as callers give it (optional keys may be present as undefined). Disabling is not
 * one: it may change a whole series (Item#setDisabled).
 */
export type OverlayEdit = {
  [K in Exclude<keyof UpdateOverlayRequestBody, 'disabled' | 'scope' | 'occurrenceStart'>]?:
    | UpdateOverlayRequestBody[K]
    | undefined;
};

export class Overlay {
  readonly #overlay: Readonly<ItemOverlay>;
  readonly #overrides: Overrides;

  private constructor(overlay: ItemOverlay) {
    this.#overlay = Object.freeze({ ...overlay, attrs: { ...overlay.attrs } });
    this.#overrides = Overrides.from(overlay.overrides);
    Object.freeze(this);
  }

  static of(overlay: ItemOverlay): Overlay {
    return new Overlay(overlay);
  }

  /**
   * What an overlay edit stores: only the fields given (null clears one), the planned date parsed
   * (400 for a date that isn't one), the attribute values checked against `settings` (400 for an
   * unknown key or a mistyped value), and `editedAt` now. The topic override is the caller's to
   * check (it reads the workspace's topics). Overrides are a mirrored item's edit's, not this.
   */
  static patch(
    edit: OverlayEdit,
    settings: WorkspaceSettings,
    now: Date = new Date(),
  ): ItemOverlayPatch {
    return {
      ...(edit.pinned === undefined ? {} : { pinned: edit.pinned }),
      ...(edit.note === undefined ? {} : { note: edit.note }),
      ...(edit.hidden === undefined ? {} : { hidden: edit.hidden }),
      ...(edit.topicOverride === undefined ? {} : { topicOverride: edit.topicOverride }),
      ...(edit.calendarSync === undefined ? {} : { calendarSync: edit.calendarSync }),
      ...(edit.plannedAt === undefined
        ? {}
        : {
            plannedAt: edit.plannedAt === null ? null : PlannedAt.parse(edit.plannedAt).toString(),
          }),
      ...(edit.attrs === undefined
        ? {}
        : {
            attrs: AttributeValues.checked(
              edit.attrs,
              AttributeDefinitions.of(settings),
            ).toStored(),
          }),
      editedAt: now,
    };
  }

  get overrides(): Overrides {
    return this.#overrides;
  }

  /** Its custom attribute values. */
  get attributes(): AttributeValues {
    return AttributeValues.of(this.#overlay.attrs);
  }

  get pinned(): boolean | null {
    return this.#overlay.pinned;
  }

  get plannedAt(): PlannedAt | null {
    return PlannedAt.from(this.#overlay.plannedAt);
  }

  get calendarSync(): boolean | null {
    return this.#overlay.calendarSync;
  }

  get topicOverride(): string | null {
    return this.#overlay.topicOverride;
  }

  get editedAt(): Date | null {
    return this.#overlay.editedAt;
  }

  /** Whether it, or occurrences of its series, are disabled in TodoList (Disabled.ts). */
  get disabledState(): DisabledState {
    return DisabledState.of(this.#overlay);
  }

  /** H5: the local to-do this mirrored item is the provider copy of (null: none). */
  get copyOf(): string | null {
    return this.#overlay.copyOf;
  }

  /** As the API shows it: text redacted, attribute dates as ISO strings. */
  toView(): ItemOverlayView {
    const overlay = this.#overlay;
    return {
      pinned: overlay.pinned,
      note: overlay.note === null ? null : redactString(overlay.note),
      hidden: overlay.hidden,
      topicOverride: overlay.topicOverride,
      calendarSync: overlay.calendarSync,
      plannedAt: overlay.plannedAt,
      editedAt: overlay.editedAt,
      attrs: this.attributes.toView(),
      disabled: overlay.disabled,
      disabledOccurrences: [...overlay.disabledOccurrences],
      overrides: this.#overrides.toView(),
    };
  }
}
