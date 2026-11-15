/**
 * Taking back what TodoList added at a Google calendar, always on its owner's explicit request
 * (never on its own), as a template method within a time budget:
 *
 * - `PushedEventsRemoval` ("Remove" on an earlier workspace calendar's leftovers, and the Change
 *   and Stop dialogs' checkbox): the integration's own live pushed events;
 * - `AddedContentRemoval` ("Also remove everything TodoList added" before a disconnect): those
 *   events, then each calendar TodoList created on the integration that holds nothing else, then
 *   every link.
 *
 * Each step's Google call is the integration's own (CleanupSubject: its write session, its audit,
 * its allow-list); this class only orders them and keeps the budget. At least one step runs per
 * call, so every call makes progress; when the budget runs out first, CleanupIncompleteError
 * (409 `cleanup_incomplete`) carries how far it got, and the next call goes on from there.
 */
import {
  CleanupIncompleteError,
  type CleanupProgress,
} from '../../../errors/CleanupIncompleteError.js';
import type { CalendarLinkData } from '../../../models/definitions/CalendarLink.js';
import { TimeBudget, WRITE_BUDGET_MS } from './TimeBudget.js';

export type { CleanupProgress };

/** Whether a calendar TodoList created holds anything it did not add: `gone` when Google no longer has it. */
export type CalendarContents = 'others' | 'only_ours' | 'gone';

/** What a clean-up asks of its integration: each a provider write or read of its own. */
export interface CleanupSubject {
  /** Its own live links to events TodoList pushed (CalendarLink.isOwnLive). */
  ownLiveLinks(): Promise<CalendarLinkData[]>;
  /** One pushed event deleted (write session, audited), then its link tombstoned. */
  deleteLink(link: CalendarLinkData): Promise<void>;
  /** The calendars TodoList created on it. */
  createdCalendars(): readonly string[];
  /** A read: what a calendar TodoList created holds. */
  contentsOf(calendarId: string): Promise<CalendarContents>;
  /** A calendar TodoList created, deleted (write session, audited). */
  deleteCalendar(calendarId: string): Promise<void>;
  /** A calendar deleted (or gone) is no longer read or recorded as TodoList's. */
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

export abstract class CalendarCleanup {
  protected readonly subject: CleanupSubject;
  readonly #budget: TimeBudget;
  #steps = 0;
  protected readonly progress: CleanupProgress = {
    events: 0,
    calendars: 0,
    calendarsKept: 0,
    remaining: 0,
  };

  constructor(subject: CleanupSubject, budget: TimeBudget = TimeBudget.start(budgetMs)) {
    this.subject = subject;
    this.#budget = budget;
  }

  /** The template: the pushed events first, then the steps of the kind of clean-up. */
  async run(): Promise<CleanupProgress> {
    const links = await this.subject.ownLiveLinks();
    for (const [index, link] of links.entries()) {
      this.#stopIfOutOfTime(links.length - index + this.pendingAfterEvents());
      await this.subject.deleteLink(link);
      this.progress.events += 1;
    }
    await this.afterEvents();
    return { ...this.progress };
  }

  /** What the steps after the events still have to do (counted in `remaining`). */
  protected abstract pendingAfterEvents(): number;

  /** The steps after the events (none for a removal of pushed events alone). */
  protected abstract afterEvents(): Promise<void>;

  /** One more step, unless the budget is spent after at least one step ran this call. */
  protected stopIfOutOfTime(remaining: number): void {
    this.#stopIfOutOfTime(remaining);
  }

  #stopIfOutOfTime(remaining: number): void {
    if (this.#steps > 0 && this.#budget.exhausted) {
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
 * nothing else (one that does is kept: its events are someone else's), then every link.
 */
export class AddedContentRemoval extends CalendarCleanup {
  protected pendingAfterEvents(): number {
    return this.subject.createdCalendars().length;
  }

  protected async afterEvents(): Promise<void> {
    const calendars = this.subject.createdCalendars();
    for (const [index, calendarId] of calendars.entries()) {
      this.stopIfOutOfTime(calendars.length - index);
      const contents = await this.subject.contentsOf(calendarId);
      if (contents === 'others') {
        this.progress.calendarsKept += 1;
        continue;
      }
      if (contents === 'only_ours') {
        await this.subject.deleteCalendar(calendarId);
        this.progress.calendars += 1;
      }
      await this.subject.forgetCalendar(calendarId);
    }
    await this.subject.removeLinks();
  }
}
