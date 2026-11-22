import type { ContainerType, IntegrationMode, ItemKind, ItemStatus, Provider } from './domain.js';
import type { BlockLayer } from './scheduled.js';
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

/**
 * Which occurrences a Disable or an Enable of a repeating item applies to: `occurrence` (one, by
 * its original start) or `series` (every occurrence; a Google series' moved and cancelled ones
 * too).
 */
export const DISABLE_SCOPES = ['occurrence', 'series'] as const;
export type DisableScope = (typeof DISABLE_SCOPES)[number];

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
  /**
   * Disabled in TodoList (a series: every occurrence): shown faded and struck through, its time
   * free. Never written to a provider. null: not disabled.
   */
  disabled: boolean | null;
  /** A series' occurrences disabled one by one: their original starts (ISO 8601). */
  disabledOccurrences: string[];
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
  /**
   * The caller can write the provider fields now: their own, read & write, writes on here, and its
   * grant carries the provider's write scope.
   */
  canWriteProvider: boolean;
  /**
   * Its owner's grant lacks the provider's write scope (one from before writes were on): they
   * connect it again with Read & write on. False for anyone else.
   */
  needsReconnect: boolean;
  /** A calendar event with other guests: an edit says whether to notify them (`notifyGuests`). */
  needsGuestNotice: boolean;
}

/**
 * A mirrored item's own values at its provider, before any override: what the item sheet's "Use
 * <provider>'s value" is labelled with. Null clears any override (title, status, dates, priority);
 * these values only say what it goes back to. The title is redacted like the item's.
 */
export interface ItemSourceValuesView {
  title: string;
  status: ItemStatus;
  dueAt: Date | null;
  allDay: boolean;
  startAt: Date | null;
  priority: number | null;
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

/**
 * `GET …/items`, viewer. Sorted by `dueAt` (no date first), then id; status, due dates and the
 * order read the items' effective values. `cursor` is the opaque `nextCursor` of the previous page;
 * `limit` is 1–100 (default 50). `q` is a text search over the title (a title override too) and
 * preview. 400 for a bad filter or cursor.
 */
export interface ListItemsQuery {
  kind?: ItemKind;
  provider?: Provider;
  /** A topic's id. */
  topicId?: string;
  containerId?: string;
  status?: ItemStatus;
  dueFrom?: string;
  dueTo?: string;
  q?: string;
  cursor?: string;
  limit?: number;
}

export interface ListItemsResponseData {
  items: ItemSummary[];
  nextCursor: string | null;
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
  /** A time block's layer (`block`, or `area` for painted time); absent on every other item. */
  layer?: BlockLayer;
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
  /** A mirrored item's values at its provider, before its overrides; null for a to-do. */
  sourceValues: ItemSourceValuesView | null;
  /**
   * A moved occurrence of a repeating calendar event (its own row): the series it belongs to (its
   * master's item id, or its own when the caller doesn't see the master) and the occurrence's
   * original start (ISO). Travel keeps a mark of that occurrence under them. Ids and times only;
   * absent on any other item.
   */
  seriesOccurrence?: {
    seriesId: string;
    originalStart: string;
    /**
     * What its series' master says of this occurrence: disabled with the whole series, disabled on
     * its own (the master lists its slot), or null.
     */
    disabled: 'series' | 'occurrence' | null;
  };
}

/**
 * Editor; at least one change. A to-do changes its own fields. A mirrored item's edit is split:
 * - its provider fields for its kind (`editing.providerFields`) are written to the provider, by
 *   its integration's owner only (403 `integration_not_owner`) and only while it is read & write
 *   (409 `integration_read_only`); an event with other guests needs `notifyGuests` (409
 *   `event_has_guests`);
 * - the fields its provider lacks (`editing.overridableFields`) are kept here as overrides, by any
 *   editor who sees it (null, or the provider's own value, clears one, `title` and `status` too; null on a
 *   provider field or on a local to-do is 400; an `allDay` kept here is a
 *   due date's, for an item without a start: one with a start, an event, keeps its own form: 400);
 * - anything else (`note`, `topicId`, `containerId`, an `endAt` the provider doesn't take) is
 *   edited at its source: 409 `{message, openIn}`.
 * A provider refusal answers `{message, code, details}` (`details`: `fields`, `openIn`, `written`,
 * `refused`, `uncertain`, as the code has them).
 */
export interface UpdateItemRequestBody {
  /** null clears a title override of a mirrored item (400 on a provider title or a to-do). */
  title?: string | null;
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
  /** null clears a status override of a mirrored item (400 on a provider status or a to-do). */
  status?: ItemStatus | null;
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
  /** A partial write: the fields kept in TodoList from the same edit (its overrides). */
  kept?: string[];
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
  /**
   * Disable (true) or enable again (false) the item, or occurrences of its series (`scope`): kept
   * in TodoList only, never written to a provider. A travel leg is skipped, not disabled (400).
   */
  disabled?: boolean;
  /**
   * With `disabled`, for an item that repeats or one occurrence of a series: `occurrence` (needs
   * `occurrenceStart` on a series' master) or `series`. Left out: one occurrence when
   * `occurrenceStart` is given or the item is one occurrence itself, else the whole item. Enabling
   * one occurrence of a series disabled as a whole is 400 (enable the series).
   */
  scope?: DisableScope;
  /** With `disabled`: the occurrence's original start, ISO 8601 (400 `not_an_occurrence`). */
  occurrenceStart?: string;
}

export type UpdateOverlayResponseData = ItemDetail;

/** Viewer. 404 for an item outside the caller's access. */
export type GetItemResponseData = ItemDetail;

/** One container the caller may see. */
export interface FacetContainer {
  id: string;
  name: string;
  /**
   * What topic rules match: a GitHub repo's `owner/repo` or board's `owner/projects/<n>`, else the
   * name. A container's own rule (File under) has this as its `match`.
   */
  matchKey: string;
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
