/**
 * How a sync of one integration is asked for (Integration.runSync, Integration#sync): types only,
 * so the worker, the seed and the tests name them without loading the engine.
 */
import type { Clock, Transport } from '../../sync/http.js';
import type { SyncTrigger } from '../../types/domain.js';
import type { SyncMode } from '../../types/env.d.ts';

export interface SyncOptions {
  /** `fixtures` replays recorded responses and never decrypts. A test can force it (testSwitches). */
  mode: SyncMode;
  /** A fixture set of the adapter (default `v1`). Fixtures mode only. */
  fixtureSet?: string;
  /** The run's time (default: now). */
  now?: Date;
  /** Replaces the live or fixture transport (tests; a live run takes one only under node:test). */
  transport?: Transport;
  /** Clock for the adapter's request throttle and waits (default: the real one). Fixtures replays pass one that never waits. */
  clock?: Clock;
}

/** A trigger, for a new run; or the id of a queued run (SyncRun.request), which has its own trigger. */
export type SyncRunOptions = SyncOptions &
  ({ trigger: SyncTrigger; runId?: never } | { runId: string; trigger?: never });

/** A sync started by a trigger, not by a queued run (a batch of syncs: Integration.syncTogether). */
export type TriggeredSyncOptions = Extract<SyncRunOptions, { trigger: SyncTrigger }>;

/** The run's clock: the time it runs at, and the wall clock when it opened. */
export interface RunClock {
  now: Date;
  wallStart: number;
}
