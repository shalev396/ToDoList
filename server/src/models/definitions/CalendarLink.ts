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
  /**
   * A `dashboard` tombstone is TodoList's claim on the event (EventClaim, taken before its DELETE
   * is sent); this is when Google answered that DELETE (made or refused for good), or when a read
   * showed it was made. Null while the claim stands unanswered, and for every other row.
   */
  deleteAnsweredAt: Date | null;
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
  deleteAnsweredAt?: Date | null;
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
   * Tombstones a live link (its `deleteAnsweredAt` cleared). With `calendarId`, only while the link
   * is still on that calendar (a push that moved it meanwhile keeps it live).
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
  /**
   * Another integration's claim on the same event (`key`): its link tombstoned `dashboard`
   * (TodoList itself deleted the event, or is deleting it: a clean-up step, a to-do's delete, a
   * push's delete or move) whose DELETE was answered since `answeredSince`, or is unanswered and
   * was claimed since `claimedSince`. Null when there is none.
   */
  findOthersStanding(
    workspaceId: string,
    integrationId: string,
    key: CalendarLinkKey,
    since: { answeredSince: Date; claimedSince: Date },
  ): Promise<CalendarLinkData | null>;
  /** The claim tombstoned at `tombstonedAt` was answered now: `deleteAnsweredAt` set, once. */
  settle(workspaceId: string, id: string, tombstonedAt: Date): Promise<boolean>;
  /** The integration's claims whose DELETE is still unanswered, claimed before `before`. */
  listUnsettledClaims(
    workspaceId: string,
    integrationId: string,
    before: Date,
  ): Promise<CalendarLinkData[]>;
  /** Whether another integration of the workspace holds a live link to the same event. */
  hasOtherLive(workspaceId: string, integrationId: string, key: CalendarLinkKey): Promise<boolean>;
  /**
   * A `dashboard` tombstone taken back (a claimed delete that was not made): the link is live
   * again, only while it is still that very claim (its `tombstonedAt`) on `calendarId`. Null
   * otherwise.
   */
  release(
    workspaceId: string,
    id: string,
    calendarId: string,
    tombstonedAt: Date,
  ): Promise<CalendarLinkData | null>;
  /** One link removed (its row, nothing at Google). False when it was not there. */
  remove(workspaceId: string, id: string): Promise<boolean>;
}

export const CALENDAR_LINK_TABLE_NAME = 'CalendarLinks';
