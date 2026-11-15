/**
 * Taking back what TodoList added at a Google calendar, always on its owner's explicit request
 * (never on its own), as a template method within the request's time budget:
 *
 * - `PushedEventsRemoval` ("Remove" on an earlier workspace calendar's leftovers, and the Change
 *   and Stop dialogs' checkbox): the integration's own live pushed events;
 * - `AddedContentRemoval` ("Also remove everything TodoList added" before a disconnect): those
 *   events, then each calendar TodoList created on the integration that holds nothing else, then
 *   every link.
 *
 * Rules every clean-up keeps:
 * - the CURRENT workspace calendar is never touched (`isProtected`): its events are skipped and
 *   it is never deleted, unless the clean-up is the disconnect of the very integration it is on;
 * - a step Google refuses for good (no permission) is recorded and dropped from tracking, so the
 *   next call moves on (`failed`); a busy or silent Google stops the call (the next one retries);
 * - a step starts only while the budget leaves a call's longest time (TimeBudget#canStart), and
 *   at least one step runs per call, so every call makes progress; when time runs out first,
 *   CleanupIncompleteError (409 `cleanup_incomplete`) carries how far it got.
 *
 * Each step's Google call is the integration's own (CleanupSubject: its write session, its audit,
 * its allow-list); this class only orders the steps and keeps the budget.
 */
import {
  CleanupIncompleteError,
  type CleanupProgress,
} from '../../../errors/CleanupIncompleteError.js';
import type { CalendarLinkData } from '../../../models/definitions/CalendarLink.js';
import { TimeBudget, WRITE_BUDGET_MS } from './TimeBudget.js';

export type { CleanupProgress };

/**
 * Whether a calendar TodoList created holds anything it did not add: `gone` when Google no longer
 * has it, `later` when its listing could not be read whole within the budget (the next call reads).
 */
export type CalendarContents = 'others' | 'only_ours' | 'gone' | 'later';

/**
 * How one step at Google ended: done, refused for good (recorded, no longer tracked), or skipped
 * (re-read just before: the link moved, went, or is now on the current workspace calendar).
 */
export type StepOutcome = 'done' | 'refused' | 'skipped';

/** What a clean-up asks of its integration: each a provider write or read of its own. */
export interface CleanupSubject {
  /** Its own live links to events TodoList pushed (CalendarLink.isOwnLive). */
  ownLiveLinks(): Promise<CalendarLinkData[]>;
  /** Whether a calendar is the current workspace calendar, which this clean-up never touches. */
  isProtected(calendarId: string): boolean;
  /**
   * One pushed event deleted (audited), then its link tombstoned; `skipped` when the link, re-read
   * just before, moved, went or is now on the current workspace calendar.
   */
  deleteLink(link: CalendarLinkData): Promise<StepOutcome>;
  /** The calendars TodoList created on it. */
  createdCalendars(): readonly string[];
  /** A read: what a calendar TodoList created holds. */
  contentsOf(calendarId: string): Promise<CalendarContents>;
  /** A calendar TodoList created, deleted (audited). */
  deleteCalendar(calendarId: string): Promise<StepOutcome>;
  /** A calendar deleted, gone or refused is no longer read or recorded as TodoList's. */
  forgetCalendar(calendarId: string): Promise<void>;
  /** Every link of the integration removed. */
  removeLinks(): Promise<void>;
}

let budgetMs = WRITE_BUDGET_MS;

/** Tests only (node:test): the clean-up budget; null restores WRITE_BUDGET_MS. */
export function setCleanupBudgetForTests(ms: number | null): void {
  if ((process.env['NODE_TEST_CONTEXT'] ?? '') === '') {
    throw new Error('setCleanupBudgetForTests runs only under node:test');
  }
  budgetMs = ms ?? WRITE_BUDGET_MS;
}

/** A clean-up's budget, from now (the request's: WRITE_BUDGET_MS, or a test's). */
export function cleanupBudget(): TimeBudget {
  return TimeBudget.start(budgetMs);
}

export abstract class CalendarCleanup {
  protected readonly subject: CleanupSubject;
  readonly #budget: TimeBudget;
  #steps = 0;
  protected readonly progress: CleanupProgress = {
    events: 0,
    calendars: 0,
    calendarsKept: 0,
    remaining: 0,
    skipped: 0,
    failed: 0,
  };

  constructor(subject: CleanupSubject, budget: TimeBudget = cleanupBudget()) {
    this.subject = subject;
    this.#budget = budget;
  }

  /** The template: the pushed events first (never the current calendar's), then the kind's steps. */
  async run(): Promise<CleanupProgress> {
    const links = await this.subject.ownLiveLinks();
    const todo = links.filter((link) => !this.subject.isProtected(link.calendarId));
    this.progress.skipped = links.length - todo.length;
    for (const [index, link] of todo.entries()) {
      this.stopIfOutOfTime(todo.length - index + this.pendingAfterEvents());
      const outcome = await this.subject.deleteLink(link);
      if (outcome === 'done') this.progress.events += 1;
      else if (outcome === 'refused') this.progress.failed += 1;
      else this.progress.skipped += 1;
    }
    await this.afterEvents();
    return { ...this.progress };
  }

  /** What the steps after the events still have to do (counted in `remaining`). */
  protected abstract pendingAfterEvents(): number;

  /** The steps after the events (none for a removal of pushed events alone). */
  protected abstract afterEvents(): Promise<void>;

  /** One more step, unless a call can no longer end in time after at least one step ran. */
  protected stopIfOutOfTime(remaining: number): void {
    if (this.#steps > 0 && !this.#budget.canStart()) {
      throw new CleanupIncompleteError({ ...this.progress, remaining });
    }
    this.#steps += 1;
  }
}

/** The integration's own live pushed events, deleted; their links tombstoned. */
export class PushedEventsRemoval extends CalendarCleanup {
  protected pendingAfterEvents(): number {
    return 0;
  }

  protected afterEvents(): Promise<void> {
    return Promise.resolve();
  }
}

/**
 * Everything TodoList added: the pushed events, then each calendar TodoList created that holds
 * nothing else (one that does, or the current workspace calendar, is kept), then every link.
 */
export class AddedContentRemoval extends CalendarCleanup {
  protected pendingAfterEvents(): number {
    return this.subject.createdCalendars().length;
  }

  protected async afterEvents(): Promise<void> {
    const calendars = this.subject.createdCalendars();
    for (const [index, calendarId] of calendars.entries()) {
      if (this.subject.isProtected(calendarId)) {
        this.progress.calendarsKept += 1;
        continue;
      }
      this.stopIfOutOfTime(calendars.length - index);
      const contents = await this.subject.contentsOf(calendarId);
      if (contents === 'later') {
        throw new CleanupIncompleteError({ ...this.progress, remaining: calendars.length - index });
      }
      if (contents === 'others') {
        this.progress.calendarsKept += 1;
        continue;
      }
      if (contents === 'only_ours') {
        if ((await this.subject.deleteCalendar(calendarId)) === 'done')
          this.progress.calendars += 1;
        else this.progress.failed += 1;
      }
      await this.subject.forgetCalendar(calendarId);
    }
    await this.subject.removeLinks();
  }
}
