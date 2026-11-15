/**
 * An item's overlay, as an immutable value object: what users keep on any item, mirrored or local,
 * that the sync never touches and no provider ever receives: pin, note, hidden, a topic to file it
 * under, whether the workspace calendar takes it, a planned date, custom attribute values, and (on
 * a mirrored item) its overrides. It also carries H5's copy marks (`copyOf`…), which only the copy
 * flow sets.
 *
 * `patch()` turns an overlay edit into what is stored: the planned date parsed (PlannedAt), the
 * attribute values checked against the workspace's definitions, `editedAt` stamped. Pure.
 */
import type { ItemOverlay, ItemOverlayPatch } from '../../models/definitions/Item.js';
import type { WorkspaceSettings } from '../../models/definitions/Workspace.js';
import type { ItemOverlayView, UpdateOverlayRequestBody } from '../../types/items.js';
import { redactString } from '../../services/secretPatterns.js';
import { AttributeDefinitions } from '../workspace/AttributeDefinitions.js';
import { Overrides } from './Overrides.js';
import { PlannedAt } from './PlannedAt.js';

/** An overlay edit as callers give it (optional keys may be present as undefined). */
export type OverlayEdit = {
  [K in keyof UpdateOverlayRequestBody]?: UpdateOverlayRequestBody[K] | undefined;
};

/** Attribute values as the API shows them: dates as ISO strings, text redacted. */
function attrValues(raw: Readonly<Record<string, unknown>>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(raw)) {
    if (value === null || value === undefined) continue;
    if (value instanceof Date) out[key] = value.toISOString();
    else out[key] = typeof value === 'string' ? redactString(value) : value;
  }
  return out;
}

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
        : { attrs: AttributeDefinitions.of(settings).prepare(edit.attrs) }),
      editedAt: now,
    };
  }

  get overrides(): Overrides {
    return this.#overrides;
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
      attrs: attrValues(overlay.attrs),
      overrides: this.#overrides.toView(),
    };
  }
}
