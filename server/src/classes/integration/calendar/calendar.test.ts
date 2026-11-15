import { describe, it } from 'node:test';
import assert from 'node:assert/strict';

import type { CalendarLinkData } from '../../../models/definitions/CalendarLink.js';
import { CleanupIncompleteError } from '../../../errors/CleanupIncompleteError.js';
import { AppCreatedCalendars } from './AppCreatedCalendars.js';
import {
  AddedContentRemoval,
  PushedEventsRemoval,
  type CalendarContents,
  type CleanupSubject,
  type StepOutcome,
} from './CalendarCleanup.js';
import { TimeBudget } from './TimeBudget.js';

describe('AppCreatedCalendars', () => {
  it('reads the stored list; only valid ids, each once', () => {
    assert.deepEqual(AppCreatedCalendars.of({}).ids, []);
    assert.deepEqual(AppCreatedCalendars.of({ appCreatedCalendars: 'x' }).ids, []);
    assert.deepEqual(
      AppCreatedCalendars.of({ appCreatedCalendars: ['a@g', 'a@g', 'two words', 7, 'b@g'] }).ids,
      ['a@g', 'b@g'],
    );
  });

  it('records, forgets, and keeps the stored list over a settings change', () => {
    const stored = AppCreatedCalendars.of({ appCreatedCalendars: ['a@g'] });
    assert.deepEqual(stored.with('b@g').toJSON(), ['a@g', 'b@g']);
    assert.equal(stored.with('a@g'), stored);
    assert.deepEqual(stored.without('a@g').toJSON(), []);
    assert.deepEqual(stored.keptIn({ calendars: [], appCreatedCalendars: ['forged'] }), {
      calendars: [],
      appCreatedCalendars: ['a@g'],
    });
    assert.deepEqual(AppCreatedCalendars.of({}).keptIn({ appCreatedCalendars: ['forged'] }), {});
  });
});

describe('TimeBudget', () => {
  it('runs out at its deadline; a step starts only while a call can still end in it', () => {
    let now = 1000;
    const budget = TimeBudget.start(20_000, () => now);
    assert.equal(budget.deadline, 21_000);
    assert.equal(budget.canStart(), true);
    now = 13_000; // 8 s left: one more call fits exactly
    assert.equal(budget.canStart(), true);
    now = 13_001;
    assert.equal(budget.canStart(), false);
    assert.equal(budget.canStart(1000), true);
    assert.equal(budget.exhausted, false);
    now = 21_000;
    assert.equal(budget.exhausted, true);
    assert.equal(budget.remainingMs, 0);
  });
});

const link = (itemId: string, calendarId = 'c'): CalendarLinkData => ({
  id: `l-${itemId}`,
  workspaceId: 'w',
  integrationId: 'i',
  calendarId,
  googleEventId: `e-${itemId}`,
  itemId,
  direction: 'to_google',
  lastEtag: null,
  lastGoogleUpdated: null,
  lastItemUpdatedAt: null,
  pushedHash: null,
  tombstonedAt: null,
  deletedBy: null,
  createdAt: new Date(0),
  updatedAt: new Date(0),
});

interface FakeOptions {
  /** The current workspace calendar (never touched). */
  protectedId?: string;
  /** Links (by item) and calendars Google refuses for good. */
  refused?: readonly string[];
  /** Links (by item) found moved or gone when re-read just before their delete. */
  moved?: readonly string[];
  /** Links on another calendar than `c`, by item. */
  elsewhere?: Readonly<Record<string, string>>;
}

/** A subject that records what it was asked, with each step advancing a fake clock by 10 ms. */
function subject(
  links: string[],
  calendars: Record<string, CalendarContents>,
  options: FakeOptions = {},
): { subject: CleanupSubject; log: string[]; clock: () => number } {
  const log: string[] = [];
  let now = 0;
  const step = (entry: string): Promise<void> => {
    log.push(entry);
    now += 10;
    return Promise.resolve();
  };
  const outcome = async (entry: string, id: string): Promise<StepOutcome> => {
    if (options.moved?.includes(id) === true) return 'skipped';
    await step(entry);
    return options.refused?.includes(id) === true ? 'refused' : 'done';
  };
  return {
    log,
    clock: () => now,
    subject: {
      ownLiveLinks: () =>
        Promise.resolve(
          links
            .filter((id) => !log.includes(`delete ${id}`))
            .map((id) => link(id, options.elsewhere?.[id] ?? 'c')),
        ),
      isProtected: (calendarId) => calendarId === options.protectedId,
      deleteLink: (entry) => outcome(`delete ${entry.itemId}`, entry.itemId),
      createdCalendars: () => Object.keys(calendars).filter((id) => !log.includes(`forget ${id}`)),
      contentsOf: (id): Promise<CalendarContents> => {
        log.push(`read ${id}`);
        now += 10;
        return Promise.resolve(calendars[id] ?? 'gone');
      },
      deleteCalendar: (id) => outcome(`remove ${id}`, id),
      forgetCalendar: (id) => step(`forget ${id}`),
      removeLinks: () => step('links'),
    },
  };
}

const counts = (over: Partial<Record<string, number>> = {}): Record<string, number> => ({
  events: 0,
  calendars: 0,
  calendarsKept: 0,
  remaining: 0,
  skipped: 0,
  failed: 0,
  ...over,
});

describe('CalendarCleanup', () => {
  it('everything TodoList added: events, then its calendars (kept, deleted, gone), then the links', async () => {
    const { subject: s, log } = subject(['a', 'b'], {
      mine: 'only_ours',
      theirs: 'others',
      gone: 'gone',
    });
    const done = await new AddedContentRemoval(s, TimeBudget.start(60_000)).run();
    assert.deepEqual(done, counts({ events: 2, calendars: 1, calendarsKept: 1 }));
    assert.deepEqual(log, [
      'delete a',
      'delete b',
      'read mine',
      'remove mine',
      'forget mine',
      'read theirs',
      'read gone',
      'forget gone',
      'links',
    ]);
  });

  it('out of time: at least one step per call, then 409 with the progress; the next call goes on', async () => {
    const { subject: s, log, clock } = subject(['a', 'b', 'c'], { mine: 'only_ours' });
    // 8,005 ms: the first step runs; then a call (8 s) no longer fits.
    await assert.rejects(
      new AddedContentRemoval(s, TimeBudget.start(8_005, clock)).run(),
      (error: unknown) =>
        error instanceof CleanupIncompleteError &&
        error.code === 'cleanup_incomplete' &&
        error.statusCode === 409 &&
        JSON.stringify(error.progress) === JSON.stringify(counts({ events: 1, remaining: 3 })),
    );
    assert.deepEqual(log, ['delete a']);
    const done = await new AddedContentRemoval(s, TimeBudget.start(60_000, clock)).run();
    assert.deepEqual(done, counts({ events: 2, calendars: 1 }));
  });

  it('the pushed events alone: no calendar is read, and no link is removed', async () => {
    const { subject: s, log } = subject(['a'], { mine: 'only_ours' });
    const done = await new PushedEventsRemoval(s, TimeBudget.start(60_000)).run();
    assert.deepEqual(done, counts({ events: 1 }));
    assert.deepEqual(log, ['delete a']);
  });

  it('never touches the current workspace calendar: its events skipped, the calendar kept', async () => {
    // Links on `c` (the current calendar) and one left on an old calendar.
    const { subject: s, log } = subject(
      ['a', 'b', 'old'],
      { c: 'only_ours', mine: 'only_ours' },
      { protectedId: 'c', elsewhere: { old: 'old-calendar' } },
    );
    const done = await new AddedContentRemoval(s, TimeBudget.start(60_000)).run();
    assert.deepEqual(done, counts({ events: 1, calendars: 1, calendarsKept: 1, skipped: 2 }));
    assert.equal(log.includes('delete a'), false);
    assert.equal(log.includes('read c'), false, 'the current calendar is never even read');
    assert.equal(log.includes('remove c'), false);
  });

  it('a step Google refuses for good is counted and passed, so the rest goes on', async () => {
    const { subject: s, log } = subject(
      ['a', 'b', 'c'],
      { mine: 'only_ours' },
      { refused: ['b', 'mine'] },
    );
    const done = await new AddedContentRemoval(s, TimeBudget.start(60_000)).run();
    assert.deepEqual(done, counts({ events: 2, failed: 2 }));
    assert.ok(log.includes('delete c'));
    assert.ok(log.includes('forget mine'), 'a refused calendar is no longer tracked');
  });

  it('a link found moved or gone when re-read just before its delete is skipped, not deleted', async () => {
    const { subject: s, log } = subject(['a', 'b'], {}, { moved: ['a'] });
    const done = await new PushedEventsRemoval(s, TimeBudget.start(60_000)).run();
    assert.deepEqual(done, counts({ events: 1, skipped: 1 }));
    assert.deepEqual(log, ['delete b']);
  });
});
