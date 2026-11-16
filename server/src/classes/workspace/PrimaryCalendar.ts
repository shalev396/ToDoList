/**
 * The workspace's primary calendar (plan Addendum A2) as an immutable value object: one Google
 * calendar (`calendarId`) of one Google Calendar integration (`integrationId`). Every push goes
 * there and nowhere else. A workspace owner chooses it among the integrations they own that are
 * read & write (Workspace#setPrimaryCalendar); it stays stored when that integration later goes
 * read-only or is disconnected, and is then suspended (`PrimaryCalendarStatus`).
 */
import { z } from 'zod';

import { ValidationError } from '../../errors/ValidationError.js';
import type { PrimaryCalendarData } from '../../models/definitions/Workspace.js';
import type {
  PrimaryCalendarSuspension,
  PrimaryCalendarView,
} from '../../types/primaryCalendar.js';

/** A Google calendar id: one run of visible characters (as the Calendar API's own). */
const CalendarIdSchema = z.string().min(1).max(255).regex(/^\S+$/, 'Must be a calendar id');

const PrimaryCalendarSchema = z.strictObject({
  integrationId: z.string().min(1).max(100),
  calendarId: CalendarIdSchema,
});

export class PrimaryCalendar {
  readonly #integrationId: string;
  readonly #calendarId: string;

  private constructor(data: PrimaryCalendarData) {
    this.#integrationId = data.integrationId;
    this.#calendarId = data.calendarId;
    Object.freeze(this);
  }

  /** A new choice: the ids checked (400 naming the field). */
  static of(integrationId: string, calendarId: string): PrimaryCalendar {
    const parsed = PrimaryCalendarSchema.safeParse({ integrationId, calendarId });
    if (!parsed.success) {
      const field = parsed.error.issues[0]?.path[0];
      throw new ValidationError(
        `${typeof field === 'string' ? field : 'primaryCalendar'}: not a valid id`,
      );
    }
    return new PrimaryCalendar(parsed.data);
  }

  /** As stored: null for none, or for anything that is not a valid choice (never trusted blindly). */
  static from(stored: unknown): PrimaryCalendar | null {
    const parsed = PrimaryCalendarSchema.safeParse(stored);
    return parsed.success ? new PrimaryCalendar(parsed.data) : null;
  }

  get integrationId(): string {
    return this.#integrationId;
  }

  get calendarId(): string {
    return this.#calendarId;
  }

  /** Whether it is on this integration. */
  isOn(integrationId: string): boolean {
    return this.#integrationId === integrationId;
  }

  equals(other: PrimaryCalendar | null): boolean {
    return (
      other !== null &&
      other.#integrationId === this.#integrationId &&
      other.#calendarId === this.#calendarId
    );
  }

  toJSON(): PrimaryCalendarData {
    return { integrationId: this.#integrationId, calendarId: this.#calendarId };
  }
}

/** What the integration a primary calendar is on is like now, as the status reads it. */
export interface PrimaryCalendarIntegrationState {
  /** Its owner's user id. */
  ownerUserId: string;
  /** Read & write (and writes on for it here). */
  writable: boolean;
}

/**
 * Whether the workspace's primary calendar is pushed to now: unset, active, or suspended (its
 * integration is read-only, or gone). A value object, made from the stored choice and its
 * integration as it is (null when it is disconnected or never existed).
 */
export class PrimaryCalendarStatus {
  readonly #primary: PrimaryCalendar | null;
  readonly #integration: PrimaryCalendarIntegrationState | null;

  private constructor(
    primary: PrimaryCalendar | null,
    integration: PrimaryCalendarIntegrationState | null,
  ) {
    this.#primary = primary;
    this.#integration = integration;
    Object.freeze(this);
  }

  static of(
    primary: PrimaryCalendar | null,
    integration: PrimaryCalendarIntegrationState | null,
  ): PrimaryCalendarStatus {
    return new PrimaryCalendarStatus(primary, primary === null ? null : integration);
  }

  get primary(): PrimaryCalendar | null {
    return this.#primary;
  }

  get state(): PrimaryCalendarView['state'] {
    if (this.#primary === null) return 'unset';
    return this.reason === null ? 'active' : 'suspended';
  }

  /** Why pushes are skipped while it is set; null when unset or active. */
  get reason(): PrimaryCalendarSuspension | null {
    if (this.#primary === null) return null;
    if (this.#integration === null) return 'disconnected';
    return this.#integration.writable ? null : 'read_only';
  }

  /** Whether a push may go there now. */
  get isActive(): boolean {
    return this.state === 'active';
  }

  /** Whether `userId` owns the integration it is on (who pushes, shares and sees its ids). */
  isOwnedBy(userId: string): boolean {
    return this.#integration?.ownerUserId === userId;
  }

  /** What `userId` sees: the ids only when the integration is theirs. */
  viewFor(userId: string): PrimaryCalendarView {
    const mine = this.isOwnedBy(userId);
    return {
      state: this.state,
      reason: this.reason,
      mine,
      integrationId: mine ? (this.#primary?.integrationId ?? null) : null,
      calendarId: mine ? (this.#primary?.calendarId ?? null) : null,
    };
  }
}
