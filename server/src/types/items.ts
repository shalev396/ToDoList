import type { ContainerType, IntegrationMode, ItemKind, ItemStatus, Provider } from './domain.js';
import type { WritableField } from './integrations.js';

/** Item and facet shapes of the items routes (routes/private/items.ts), kept apart so the client can import them without the controllers. */

/** Where to open the item: its provider page (or the app route of a local item). */
export interface OpenIn {
  provider: Provider;
  url: string;
}

/**
 * The fields a mirrored item may keep a local override of, where its provider lacks them for the
 * item's kind (`allDay` travels with `dueAt`).
 */
export const OVERRIDABLE_FIELDS = ['title', 'status', 'dueAt', 'startAt', 'priority'] as const;
export type OverridableField = (typeof OVERRIDABLE_FIELDS)[number];

/**
 * A mirrored item's overrides: values kept in TodoList for fields its provider lacks for its kind
 * (null: none). The item's own fields (`title`, `dueAt`…) already read as `override ?? source`;
 * these say which of them are local. Never synced, never written to the provider.
 */
export interface ItemOverridesView {
  title: string | null;
  status: ItemStatus | null;
  dueAt: Date | null;
  /** With a `dueAt` override: it has no time of day. */
  allDay: boolean | null;
  startAt: Date | null;
  priority: number | null;
}

/** The overlay: user-only fields the sync never touches. */
export interface ItemOverlayView {
  pinned: boolean | null;
  note: string | null;
  hidden: boolean | null;
  /** A topic id this user files the item under instead of its own. */
  topicOverride: string | null;
  calendarSync: boolean | null;
  /**
   * When the user plans to do it ("do it on Saturday"): a local date `YYYY-MM-DD`, or a local date
   * and time `YYYY-MM-DDTHH:mm`, in the workspace's time zone. TodoList's own: never synced, never
   * written to a provider; the workspace calendar's push places the item's event there.
   */
  plannedAt: string | null;
  editedAt: Date | null;
  /** Custom attribute values by key (dates as ISO strings); an unset one is absent. */
  attrs: Record<string, unknown>;
  /** A mirrored item's local overrides (all null on a to-do). */
  overrides: ItemOverridesView;
}

/**
 * How the item can be edited, for the caller (the item sheet's hints). A to-do edits its own
 * fields; a mirrored item's provider fields are written back to its provider by its integration's
 * owner while it is read & write, and the fields its provider lacks are kept here as overrides by
 * any editor who sees it.
 */
export interface ItemEditingView {
  /** `local`: a to-do, every field is TodoList's. `provider`: mirrored from its integration. */
  origin: 'local' | 'provider';
  /** The fields written back to the provider for this item's kind (empty for a to-do). */
  providerFields: WritableField[];
  /** The fields kept here as overrides: the provider lacks them for this kind (empty for a to-do). */
  overridableFields: OverridableField[];
  /** The statuses a write-back can set (empty unless `status` is a provider field). */
  reachableStatuses: ItemStatus[];
  /** The caller owns the item's integration: only they may change its provider fields. */
  ownsIntegration: boolean;
  /** The integration's mode, shown to its owner only (null for anyone else and for a to-do). */
  mode: IntegrationMode | null;
  /** The caller can write the provider fields now: their own, read & write, writes on here. */
  canWriteProvider: boolean;
  /** A calendar event with other guests: an edit says whether to notify them (`notifyGuests`). */
  needsGuestNotice: boolean;
}

/** A provider copy of a local to-do (H5): where it was created, and how it stands. */
export interface ItemCopyView {
  integrationId: string;
  provider: Provider;
  key: string | null;
  url: string;
  /** pending | created | failed | unknown (sent, no answer: may exist, check at the provider). */
  status: 'pending' | 'created' | 'failed' | 'unknown';
  /** The provider's own status of the copy once it is synced (open, in_progress, done…). */
  liveStatus: ItemStatus | null;
  requestId: string;
}

/** MCP.md §7.6. */
export interface ItemSummary {
  id: string;
  kind: ItemKind;
  /** Its topic's id; null = Unsorted. */
  topicId: string | null;
  title: string;
  bodyPreview: string | null;
  status: ItemStatus;
  priority: number | null;
  startAt: Date | null;
  dueAt: Date | null;
  endAt: Date | null;
  containerId: string | null;
  source: { provider: Provider; externalId: string; key: string | null; url: string };
  openIn: OpenIn;
  props: Record<string, unknown>;
  overlay: ItemOverlayView;
  /** Provider copies of a local to-do (H5); empty otherwise. */
  copies: ItemCopyView[];
  lastSeenAt: Date | null;
}

/** The full item. */
export interface ItemDetail extends ItemSummary {
  integrationId: string | null;
  statusRaw: string | null;
  allDay: boolean;
  assignees: string[];
  labels: string[];
  parentId: string | null;
  ownerUserId: string | null;
  /** `private`: only its owner sees a local to-do. */
  visibility: 'workspace' | 'private';
  closedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
  /** How the caller can edit it (the item sheet's hints). */
  editing: ItemEditingView;
}

/**
 * Editor; at least one change. A to-do changes its own fields. A mirrored item's edit is split:
 * - its provider fields for its kind (`editing.providerFields`) are written to the provider, by
 *   its integration's owner only (403 `integration_not_owner`) and only while it is read & write
 *   (409 `integration_read_only`); an event with other guests needs `notifyGuests` (409
 *   `event_has_guests`);
 * - the fields its provider lacks (`editing.overridableFields`) are kept here as overrides, by any
 *   editor who sees it (null clears one);
 * - anything else (`note`, `topicId`, `containerId`, an `endAt` the provider doesn't take) is
 *   edited at its source: 409 `{message, openIn}`.
 * A provider refusal answers `{message, code, details}` (`details`: `fields`, `openIn`, `written`,
 * `refused`, `uncertain`, as the code has them).
 */
export interface UpdateItemRequestBody {
  title?: string;
  note?: string | null;
  dueAt?: string | null;
  /** With `dueAt` (or, on an event, with `startAt` and `endAt`): it has no time of day. */
  allDay?: boolean;
  startAt?: string | null;
  endAt?: string | null;
  /** A topic of the workspace; null = Unsorted. */
  topicId?: string | null;
  containerId?: string | null;
  priority?: number | null;
  status?: ItemStatus;
  /** A calendar event with other guests: whether Google tells them about the change. */
  notifyGuests?: boolean;
}

/** What a write-back refusal's `details` may carry (field names only, never values). */
export interface WriteBackErrorDetails {
  fields?: string[];
  openIn?: OpenIn | null;
  written?: string[];
  refused?: string[];
  uncertain?: string[];
}

export type UpdateItemResponseData = ItemDetail;

/** Editor. Any item; never writes to the provider. At least one field. */
export interface UpdateOverlayRequestBody {
  pinned?: boolean | null;
  note?: string | null;
  hidden?: boolean | null;
  topicOverride?: string | null;
  calendarSync?: boolean | null;
  /** `YYYY-MM-DD` or `YYYY-MM-DDTHH:mm` (the workspace's local time); null clears it. */
  plannedAt?: string | null;
  /** Attribute values by key; null clears one. Unknown keys and mistyped values are 400. */
  attrs?: Record<string, string | number | boolean | string[] | null>;
}

export type UpdateOverlayResponseData = ItemDetail;

/** Viewer. 404 for an item outside the caller's access. */
export type GetItemResponseData = ItemDetail;

/** One container the caller may see. */
export interface FacetContainer {
  id: string;
  name: string;
  type: ContainerType;
  /** Its topic's id; null = Unsorted. */
  topicId: string | null;
  provider: Provider;
  /** Its integration (a block's connector). */
  integrationId: string;
  /** Its id at the provider (a Google calendar's id): what a block's connector scope names. */
  externalId: string;
}

/**
 * Viewer. What is present in the workspace, inside the caller's access: drives every filter.
 * `containers` is capped at 500 (by name).
 */
export interface FacetsResponseData {
  providers: Provider[];
  /** Topic ids present (Unsorted is not listed). */
  topics: string[];
  kinds: ItemKind[];
  statuses: ItemStatus[];
  containers: FacetContainer[];
}
