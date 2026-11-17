/**
 * The write-back's shared types (plan Addendum A1): what one edit of a mirrored item sends its
 * provider. TaskEdit builds them, the provider classes read them, and the write client's update
 * bodies are built from them (the writer depends on these, never the other way round). Types only.
 */
import type { ItemStatus } from '../../types/domain.js';

/** A due date as a write-back sends it: the instant, and whether it has no time of day. */
export interface DueChange {
  readonly at: Date;
  readonly allDay: boolean;
}

/**
 * The fields of one write-back the update bodies are built from (each present only when it
 * changes); the status travels apart, as what the provider named (a transition, a status, a state).
 */
export interface UpdateFields {
  readonly title?: string;
  /** null clears it. */
  readonly due?: DueChange | null;
  /** null clears it. */
  readonly startAt?: Date | null;
  /** 0 (lowest) … 4 (highest) on the dashboard's scale; null for none. */
  readonly priority?: number | null;
  /** The workspace's: a date-only due date is the day the instant falls on there. */
  readonly timeZone: string;
}

/** What a provider is sent: the changed fields it takes, and the status it is asked for. */
export interface ProviderPatch extends UpdateFields {
  readonly status?: ItemStatus;
}
