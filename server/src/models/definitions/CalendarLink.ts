import type { CalendarLinkDirection } from '../../types/domain.js';

/**
 * Who ended a link: `google` (deleted there), `dashboard` (TodoList deleted the event), or
 * `google_kept` (deleted in Google, but the item is another member's: TodoList only stops sending
 * it, for good, until the item is edited; this tombstone never ages out).
 */
export type CalendarLinkDeletedBy = 'google' | 'dashboard' | 'google_kept';

/** One item ↔ Google event mapping of the personal calendar bridge (DATA.md §3.15). */
export interface CalendarLinkData {
  id: string;
  workspaceId: string;
  integrationId: string;
  calendarId: string;
  googleEventId: string;
  itemId: string;
  direction: CalendarLinkDirection;
  /** Echo detection. */
  lastEtag: string | null;
  lastGoogleUpdated: Date | null;
  lastItemUpdatedAt: Date | null;
  pushedHash: string | null;
  tombstonedAt: Date | null;
  deletedBy: CalendarLinkDeletedBy | null;
  createdAt: Date;
  updatedAt: Date;
}

export interface CalendarLinkKey {
  calendarId: string;
  googleEventId: string;
}

/** `itemId` and `direction` are always given, so an insert is complete. */
export interface CalendarLinkPatch {
  itemId: string;
  direction: CalendarLinkDirection;
  lastEtag?: string | null;
  lastGoogleUpdated?: Date | null;
  lastItemUpdatedAt?: Date | null;
  pushedHash?: string | null;
  tombstonedAt?: Date | null;
  deletedBy?: CalendarLinkDeletedBy | null;
}

export interface ICalendarLinkRepository {
  /**
   * The item's one link of this integration (`patch.itemId`), created or updated, now at `key`:
   * a link that moves to another calendar (the primary calendar changed) keeps its row. The
   * unique indexes (DATA.md §6) have no `workspaceId`: callers must first resolve the parent
   * integration with a workspace-scoped `findById`.
   */
  upsert(
    workspaceId: string,
    integrationId: string,
    key: CalendarLinkKey,
    patch: CalendarLinkPatch,
  ): Promise<CalendarLinkData>;
  /** The item's link, tombstoned or not. */
  findByItem(
    workspaceId: string,
    integrationId: string,
    itemId: string,
  ): Promise<CalendarLinkData | null>;
  /** Links that are not tombstoned. */
  listLive(workspaceId: string, integrationId: string): Promise<CalendarLinkData[]>;
  /** The item's links that are not tombstoned, of any integration of the workspace. */
  listLiveForItem(workspaceId: string, itemId: string): Promise<CalendarLinkData[]>;
  /**
   * The `google_kept` tombstones, whatever their age: another member's items deleted in Google,
   * which stay unsent until edited.
   */
  listKeptStops(workspaceId: string, integrationId: string): Promise<CalendarLinkData[]>;
  /** Tombstoned links whose tombstone is newer than `since` (the 30-day window). */
  listTombstonedSince(
    workspaceId: string,
    integrationId: string,
    since: Date,
  ): Promise<CalendarLinkData[]>;
  /** By Google event id: the pull maps an event to its link. */
  findByEvent(
    workspaceId: string,
    integrationId: string,
    key: CalendarLinkKey,
  ): Promise<CalendarLinkData | null>;
  /**
   * Tombstones a live link. With `calendarId`, only while the link is still on that calendar (a
   * push that moved it meanwhile keeps it live).
   */
  tombstone(
    workspaceId: string,
    id: string,
    deletedBy: CalendarLinkDeletedBy,
    calendarId?: string,
  ): Promise<CalendarLinkData | null>;
  /**
   * One tracker per event: the OTHER integrations' live links of the workspace to the same event
   * (`key`) are removed, rows only, once `integrationId` created or adopted it. Returns how many.
   */
  removeOthersForEvent(
    workspaceId: string,
    integrationId: string,
    key: CalendarLinkKey,
  ): Promise<number>;
  /**
   * Every link of the integration, tombstoned or not, removed (what TodoList added was taken back
   * before a disconnect). Returns how many.
   */
  removeForIntegration(workspaceId: string, integrationId: string): Promise<number>;
}

export const CALENDAR_LINK_TABLE_NAME = 'CalendarLinks';
