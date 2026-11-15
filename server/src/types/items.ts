import type { ContainerType, ItemKind, ItemStatus, Provider } from './domain.js';

/** Item and facet shapes of the items routes (routes/private/items.ts), kept apart so the client can import them without the controllers. */

/** Where to open the item: its provider page (or the app route of a local item). */
export interface OpenIn {
  provider: Provider;
  url: string;
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
}

/**
 * Editor. Local items only; at least one change. A mirrored item is edited at its source:
 * 409 `{message, openIn}`.
 */
export interface UpdateItemRequestBody {
  title?: string;
  note?: string | null;
  dueAt?: string | null;
  /** A topic of the workspace; null = Unsorted. */
  topicId?: string | null;
  containerId?: string | null;
  priority?: number | null;
  status?: ItemStatus;
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
