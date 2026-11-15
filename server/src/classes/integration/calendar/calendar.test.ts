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
  it('runs out at its deadline', () => {
    let now = 1000;
    const budget = TimeBudget.start(50, () => now);
    assert.equal(budget.deadline, 1050);
    assert.equal(budget.exhausted, false);
    now = 1050;
    assert.equal(budget.exhausted, true);
  });
});

const link = (itemId: string): CalendarLinkData => ({
  id: `l-${itemId}`,
  workspaceId: 'w',
  integrationId: 'i',
  calendarId: 'c',
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

/** A subject that records what it was asked, with each step advancing a fake clock by 10 ms. */
function subject(
  links: string[],
  calendars: Record<string, CalendarContents>,
): { subject: CleanupSubject; log: string[]; clock: () => number } {
  const log: string[] = [];
  let now = 0;
  const step = (entry: string): Promise<void> => {
    log.push(entry);
    now += 10;
    return Promise.resolve();
  };
  return {
    log,
    clock: () => now,
    subject: {
      ownLiveLinks: () =>
        Promise.resolve(links.filter((id) => !log.includes(`delete ${id}`)).map(link)),
      deleteLink: (entry) => step(`delete ${entry.itemId}`),
      createdCalendars: () => Object.keys(calendars).filter((id) => !log.includes(`forget ${id}`)),
      contentsOf: (id): Promise<CalendarContents> => {
        log.push(`read ${id}`);
        now += 10;
        return Promise.resolve(calendars[id] ?? 'gone');
      },
      deleteCalendar: (id) => step(`remove ${id}`),
      forgetCalendar: (id) => step(`forget ${id}`),
      removeLinks: () => step('links'),
    },
  };
}

describe('CalendarCleanup', () => {
  it('everything TodoList added: events, then its calendars (kept, deleted, gone), then the links', async () => {
    const { subject: s, log } = subject(['a', 'b'], {
      mine: 'only_ours',
      theirs: 'others',
      gone: 'gone',
    });
    const done = await new AddedContentRemoval(s, TimeBudget.start(60_000)).run();
    assert.deepEqual(done, { events: 2, calendars: 1, calendarsKept: 1, remaining: 0 });
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
    await assert.rejects(
      new AddedContentRemoval(s, TimeBudget.start(5, clock)).run(),
      (error: unknown) =>
        error instanceof CleanupIncompleteError &&
        error.code === 'cleanup_incomplete' &&
        error.statusCode === 409 &&
        JSON.stringify(error.progress) ===
          JSON.stringify({ events: 1, calendars: 0, calendarsKept: 0, remaining: 3 }),
    );
    assert.deepEqual(log, ['delete a']);
    const done = await new AddedContentRemoval(s, TimeBudget.start(60_000, clock)).run();
    assert.deepEqual(done, { events: 2, calendars: 1, calendarsKept: 0, remaining: 0 });
  });

  it('the pushed events alone: no calendar is read, and no link is removed', async () => {
    const { subject: s, log } = subject(['a'], { mine: 'only_ours' });
    const done = await new PushedEventsRemoval(s, TimeBudget.start(60_000)).run();
    assert.deepEqual(done, { events: 1, calendars: 0, calendarsKept: 0, remaining: 0 });
    assert.deepEqual(log, ['delete a']);
  });
});
