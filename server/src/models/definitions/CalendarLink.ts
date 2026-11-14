import type { CalendarLinkDirection } from '../../types/domain.js';

export type CalendarLinkDeletedBy = 'google' | 'dashboard';

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
   * The unique indexes (DATA.md §6) have no `workspaceId`: callers must first resolve the parent
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
  tombstone(
    workspaceId: string,
    id: string,
    deletedBy: CalendarLinkDeletedBy,
  ): Promise<CalendarLinkData | null>;
}

export const CALENDAR_LINK_TABLE_NAME = 'CalendarLinks';
