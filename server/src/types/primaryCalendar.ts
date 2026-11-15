/**
 * The workspace's primary calendar over the API (plan Addendum A2): the one Google calendar every
 * push goes to. Shapes only (routes/private/primaryCalendar.ts serves them).
 */

/** Why a primary calendar that is set is not pushed to now: its integration is read-only, or gone. */
export type PrimaryCalendarSuspension = 'read_only' | 'disconnected';

/** What a member sees of the workspace's primary calendar. */
export interface PrimaryCalendarView {
  /**
   * `unset`: none chosen, nothing is pushed. `active`: the push goes there. `suspended`: chosen,
   * but its integration is read-only or disconnected, so pushes are skipped until it is fixed.
   */
  state: 'unset' | 'active' | 'suspended';
  /** Why it is suspended; null otherwise. */
  reason: PrimaryCalendarSuspension | null;
  /** Whether the caller owns its integration: only they push, share and see its ids. */
  mine: boolean;
  /** Its integration, to that integration's owner only (null otherwise, and when unset). */
  integrationId: string | null;
  /** Its Google calendar id, to that integration's owner only (null otherwise, and when unset). */
  calendarId: string | null;
}

/**
 * Workspace owner only, with a Google Calendar integration of their own that is read & write:
 * one of its account's calendars it can write (`calendarId`), or a new calendar TodoList creates
 * there (`newCalendarName`, one line of 1–255 characters; it needs the `calendar.app.created`
 * permission: 409 `scope_missing` until Google is connected again).
 */
export type SetPrimaryCalendarRequestBody =
  | { integrationId: string; calendarId: string }
  | { integrationId: string; newCalendarName: string };

/**
 * How far taking back what TodoList added got (counts only): the `progress` of a 409
 * `cleanup_incomplete` (remove-pushed, or a disconnect with removeAdded).
 */
export interface CleanupProgress {
  /** Pushed events deleted at the provider. */
  events: number;
  /** Calendars TodoList created, deleted. */
  calendars: number;
  /** Calendars TodoList created, kept because they hold events it did not add. */
  calendarsKept: number;
  /** What is left: events and calendars not reached yet. */
  remaining: number;
}
