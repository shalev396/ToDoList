/**
 * What one push to the workspace's primary calendar would do (plan Addendum A2), as a value
 * object: the ops to send (at most `maxOpsPerRun`), one entry per planned op, the skipped items
 * and the counts, with the config it was planned under. Made by Calendar#plan (the diff, gcal/
 * diff.ts, is pure); read by the push, the dry run and the scheduled sync. Deeply immutable: it
 * holds a frozen copy, and hands out frozen data (`ops`) or copies (`toDryRun`, `toJSON`).
 *
 * Also the push's own settings: a Google Calendar integration's stored config, with its defaults
 * (readGcalConfig), and the narrowing of an MCP dry run (PlanNarrowing).
 */
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { RuleGroup } from '../../types/builder.js';
import type { BuildResult, PushConfig, WireOp } from '../../gcal/diff.js';
import { deepFreeze } from '../../utils/deepFreeze.js';

export const DEFAULT_HORIZON_DAYS = 90;
export const DEFAULT_MAX_OPS = 50;

export interface CalendarEntry {
  id: string;
  mode: 'two_way' | 'read';
}

/** `Integrations.config` of a Google Calendar integration, with the defaults filled in. */
export interface GcalConfig {
  calendars: CalendarEntry[];
  horizonDays: number;
  maxOpsPerRun: number;
}

export function readGcalConfig(integration: IntegrationData): GcalConfig {
  const raw = integration.config;
  const calendars: CalendarEntry[] = [];
  if (Array.isArray(raw['calendars'])) {
    for (const entry of raw['calendars'] as unknown[]) {
      const id = (entry as { id?: unknown } | null)?.id;
      const mode = (entry as { mode?: unknown } | null)?.mode;
      if (typeof id === 'string' && id !== '') {
        calendars.push({ id, mode: mode === 'read' ? 'read' : 'two_way' });
      }
    }
  }
  const horizon = raw['horizonDays'];
  const maxOps = raw['maxOpsPerRun'];
  return {
    calendars,
    horizonDays: typeof horizon === 'number' ? horizon : DEFAULT_HORIZON_DAYS,
    maxOpsPerRun: typeof maxOps === 'number' ? maxOps : DEFAULT_MAX_OPS,
  };
}

/** Narrows the plan to some items (the MCP dry run): nothing is deleted then. */
export interface PlanNarrowing {
  where?: RuleGroup;
  range?: { from?: string; to?: string };
}

/** A plan as plain data: the diff's result, the config it ran with, the integration's config. */
export interface LoadedPlan extends BuildResult {
  /** `calendarId` is the primary calendar's. */
  cfg: PushConfig & { calendarId: string };
  config: GcalConfig;
}

export class PushPlan {
  /** A deep copy, deeply frozen: nothing handed in or out can change it. */
  readonly #plan: Readonly<LoadedPlan>;

  private constructor(plan: LoadedPlan) {
    this.#plan = deepFreeze(structuredClone(plan));
    Object.freeze(this);
  }

  static of(plan: LoadedPlan): PushPlan {
    return new PushPlan(plan);
  }

  /** What is sent: at most the integration's `maxOpsPerRun`. */
  get ops(): readonly WireOp[] {
    return this.#plan.ops;
  }

  /** The primary calendar it pushes to. */
  get calendarId(): string {
    return this.#plan.cfg.calendarId;
  }

  /** Everything pending, before the cap. */
  get counts(): { create: number; update: number; remove: number } {
    return { ...this.#plan.counts };
  }

  /** Creations still allowed today when it was planned (the daily cap). */
  get maxCreates(): number {
    return this.#plan.cfg.maxCreates;
  }

  /** The day's creations are used up, and something was held back for it. */
  get dailyCapReached(): boolean {
    return (
      this.maxCreates === 0 && this.#plan.skipped.some((entry) => entry.reason === 'daily_cap')
    );
  }

  /** What a dry run shows: counts, entries and skipped items (a copy); nothing is written. */
  toDryRun(): { dryRun: true } & Pick<BuildResult, 'counts' | 'entries' | 'skipped'> {
    const { counts, entries, skipped } = structuredClone(this.#plan);
    return { dryRun: true, counts, entries, skipped };
  }

  /** The plan as plain data: a copy. */
  toJSON(): LoadedPlan {
    return structuredClone(this.#plan);
  }

  /** Same ops into the same calendar under the same limits. */
  equals(other: PushPlan | null | undefined): boolean {
    return (
      other !== null &&
      other !== undefined &&
      JSON.stringify(this.#plan.ops) === JSON.stringify(other.#plan.ops) &&
      JSON.stringify(this.#plan.cfg) === JSON.stringify(other.#plan.cfg)
    );
  }
}
