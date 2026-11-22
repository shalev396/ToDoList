/**
 * Parity cases for the occurrence expansion: the server's and the client's tests both run every
 * case through their own import path, so the two sides agree occurrence by occurrence.
 *
 * Pure data. Every case uses Asia/Jerusalem (UTC+2 in winter, UTC+3 in summer; the clocks went
 * back on Sun 25 Oct 2026 and go forward on Fri 26 Mar 2027).
 */
import type { Inactive, TimeRow } from './occurrences.js';

export interface ParityCase {
  name: string;
  rows: TimeRow[];
  range: { from: string; to: string };
  timeZone: string;
  /** `inactive` only where the occurrence has one (cancelled or disabled). */
  expected: { key: string; start: string; end: string | null; inactive?: Inactive }[];
}

const TZ = 'Asia/Jerusalem';

/** A series occurrence's key: the series row's id and the slot's original start in ms. */
const slot = (id: string, originalStart: string): string =>
  `${id}@${String(Date.parse(originalStart))}`;

/** Sun 8 Nov 2026 00:00 to Sun 15 Nov 2026 00:00, local. */
const WEEK = { from: '2026-11-07T22:00:00.000Z', to: '2026-11-14T22:00:00.000Z' };
/** Sun 1 Nov 2026 00:00 to Sun 15 Nov 2026 00:00, local. */
const TWO_WEEKS = { from: '2026-10-31T22:00:00.000Z', to: '2026-11-14T22:00:00.000Z' };

const googleSource = (id: string): TimeRow['source'] => ({
  provider: 'google_calendar',
  key: null,
  url: `https://calendar.google.com/event?eid=${id}`,
  externalId: id,
});

const localSource = (id: string): TimeRow['source'] => ({
  provider: 'local',
  key: null,
  url: '',
  externalId: id,
});

/** Every Sunday, Tuesday and Thursday at 10:00–11:00 local, from Sun 1 Nov 2026. */
const googleMaster: TimeRow = {
  id: 'master',
  kind: 'event',
  title: 'Lecture',
  status: 'open',
  startAt: '2026-11-01T08:00:00.000Z',
  endAt: '2026-11-01T09:00:00.000Z',
  dueAt: null,
  allDay: false,
  source: googleSource('master'),
  props: { calendarId: 'c', eventId: 'e1', recurrence: ['RRULE:FREQ=WEEKLY;BYDAY=SU,TU,TH'] },
};

/** A local block: every Sunday 13:00–17:00 local, its first occurrence at `first` (ISO, UTC). */
function weeklyBlock(
  first: string,
  firstEnd: string,
  props: Record<string, unknown> = {},
  rule = 'RRULE:FREQ=WEEKLY;BYDAY=SU',
): TimeRow {
  return {
    id: 'block',
    kind: 'block',
    title: 'Math',
    status: 'open',
    startAt: first,
    endAt: firstEnd,
    dueAt: null,
    allDay: false,
    source: localSource('block'),
    props: { recurrence: [rule], ...props },
  };
}

/** Sun 1 Nov 2026 13:00–17:00 local. */
const sundayBlock = (props: Record<string, unknown> = {}): TimeRow =>
  weeklyBlock('2026-11-01T11:00:00.000Z', '2026-11-01T15:00:00.000Z', props);

export const PARITY_CASES: readonly ParityCase[] = [
  {
    name: 'single-timed',
    rows: [
      {
        id: 'single',
        kind: 'todo',
        title: 'Call the bank',
        status: 'open',
        startAt: '2026-11-10T08:00:00.000Z',
        endAt: '2026-11-10T09:00:00.000Z',
        dueAt: null,
        allDay: false,
        source: localSource('single'),
        props: {},
      },
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [
      { key: 'single', start: '2026-11-10T08:00:00.000Z', end: '2026-11-10T09:00:00.000Z' },
    ],
  },
  {
    name: 'due-only',
    rows: [
      {
        id: 'hw',
        kind: 'todo',
        title: 'Homework',
        status: 'open',
        startAt: null,
        endAt: null,
        dueAt: '2026-11-11T21:00:00.000Z',
        allDay: false,
        source: localSource('hw'),
        props: {},
      },
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [{ key: 'hw', start: '2026-11-11T21:00:00.000Z', end: null }],
  },
  {
    name: 'google-cancelled-occurrence',
    rows: [
      googleMaster,
      {
        id: 'x1',
        kind: 'event',
        title: 'Lecture',
        status: 'cancelled',
        startAt: '2026-11-10T08:00:00.000Z',
        endAt: null,
        dueAt: null,
        allDay: false,
        source: googleSource('x1'),
        props: {
          calendarId: 'c',
          recurringEventId: 'e1',
          originalStartAt: '2026-11-10T08:00:00.000Z',
        },
      },
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [
      {
        key: slot('master', '2026-11-08T08:00:00.000Z'),
        start: '2026-11-08T08:00:00.000Z',
        end: '2026-11-08T09:00:00.000Z',
      },
      {
        // Listed, cancelled, at its slot: with no end of its own, it takes the master's length.
        key: slot('master', '2026-11-10T08:00:00.000Z'),
        start: '2026-11-10T08:00:00.000Z',
        end: '2026-11-10T09:00:00.000Z',
        inactive: 'cancelled',
      },
      {
        key: slot('master', '2026-11-12T08:00:00.000Z'),
        start: '2026-11-12T08:00:00.000Z',
        end: '2026-11-12T09:00:00.000Z',
      },
    ],
  },
  {
    name: 'google-moved-occurrence',
    rows: [
      googleMaster,
      {
        id: 'x2',
        kind: 'event',
        title: 'Lecture',
        status: 'open',
        startAt: '2026-11-12T12:00:00.000Z',
        endAt: '2026-11-12T13:00:00.000Z',
        dueAt: null,
        allDay: false,
        source: googleSource('x2'),
        props: {
          calendarId: 'c',
          recurringEventId: 'e1',
          originalStartAt: '2026-11-12T08:00:00.000Z',
        },
      },
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [
      {
        key: slot('master', '2026-11-08T08:00:00.000Z'),
        start: '2026-11-08T08:00:00.000Z',
        end: '2026-11-08T09:00:00.000Z',
      },
      {
        key: slot('master', '2026-11-10T08:00:00.000Z'),
        start: '2026-11-10T08:00:00.000Z',
        end: '2026-11-10T09:00:00.000Z',
      },
      {
        // The moved occurrence keeps its original slot's key, under the master.
        key: slot('master', '2026-11-12T08:00:00.000Z'),
        start: '2026-11-12T12:00:00.000Z',
        end: '2026-11-12T13:00:00.000Z',
      },
    ],
  },
  {
    name: 'local-weekly-block',
    rows: [sundayBlock()],
    range: TWO_WEEKS,
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2026-11-01T11:00:00.000Z'),
        start: '2026-11-01T11:00:00.000Z',
        end: '2026-11-01T15:00:00.000Z',
      },
      {
        key: slot('block', '2026-11-08T11:00:00.000Z'),
        start: '2026-11-08T11:00:00.000Z',
        end: '2026-11-08T15:00:00.000Z',
      },
    ],
  },
  {
    // Every 2 weeks on Sunday and Tuesday 13:00–17:00 from Sun 22 Nov 2026, weeks starting on
    // Sunday (WKST=SU, the workspace's week): each Sunday with the Tuesday after it.
    // Sun 22 Nov 2026 00:00 to Sun 20 Dec 2026 00:00, local.
    name: 'biweekly-sun-tue-week-starts-sunday',
    rows: [
      weeklyBlock(
        '2026-11-22T11:00:00.000Z',
        '2026-11-22T15:00:00.000Z',
        {},
        'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=SU',
      ),
    ],
    range: { from: '2026-11-21T22:00:00.000Z', to: '2026-12-19T22:00:00.000Z' },
    timeZone: TZ,
    expected: ['2026-11-22', '2026-11-24', '2026-12-06', '2026-12-08'].map((day) => ({
      key: slot('block', `${day}T11:00:00.000Z`),
      start: `${day}T11:00:00.000Z`,
      end: `${day}T15:00:00.000Z`,
    })),
  },
  {
    // The same rule with weeks starting on Monday (WKST=MO, RFC 5545's default): the Tuesday is
    // the one before the next Sunday, a week off from the Sunday-start series.
    name: 'biweekly-sun-tue-week-starts-monday',
    rows: [
      weeklyBlock(
        '2026-11-22T11:00:00.000Z',
        '2026-11-22T15:00:00.000Z',
        {},
        'RRULE:FREQ=WEEKLY;INTERVAL=2;BYDAY=TU,SU;WKST=MO',
      ),
    ],
    range: { from: '2026-11-21T22:00:00.000Z', to: '2026-12-19T22:00:00.000Z' },
    timeZone: TZ,
    expected: ['2026-11-22', '2026-12-01', '2026-12-06', '2026-12-15'].map((day) => ({
      key: slot('block', `${day}T11:00:00.000Z`),
      start: `${day}T11:00:00.000Z`,
      end: `${day}T15:00:00.000Z`,
    })),
  },
  {
    // Sun 18 Oct 2026 00:00 (summer time) to Mon 2 Nov 2026 00:00 (winter time), local.
    name: 'dst-end-weekly-block',
    rows: [weeklyBlock('2026-10-18T10:00:00.000Z', '2026-10-18T14:00:00.000Z')],
    range: { from: '2026-10-17T21:00:00.000Z', to: '2026-11-01T22:00:00.000Z' },
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2026-10-18T10:00:00.000Z'),
        start: '2026-10-18T10:00:00.000Z',
        end: '2026-10-18T14:00:00.000Z',
      },
      {
        key: slot('block', '2026-10-25T11:00:00.000Z'),
        start: '2026-10-25T11:00:00.000Z',
        end: '2026-10-25T15:00:00.000Z',
      },
      {
        key: slot('block', '2026-11-01T11:00:00.000Z'),
        start: '2026-11-01T11:00:00.000Z',
        end: '2026-11-01T15:00:00.000Z',
      },
    ],
  },
  {
    // Every Friday 10:00–11:00 local; the clocks go forward early on Fri 26 Mar 2027.
    name: 'dst-start-friday',
    rows: [
      weeklyBlock(
        '2027-03-19T08:00:00.000Z',
        '2027-03-19T09:00:00.000Z',
        {},
        'RRULE:FREQ=WEEKLY;BYDAY=FR',
      ),
    ],
    range: { from: '2027-03-18T22:00:00.000Z', to: '2027-03-26T21:00:00.000Z' },
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2027-03-19T08:00:00.000Z'),
        start: '2027-03-19T08:00:00.000Z',
        end: '2027-03-19T09:00:00.000Z',
      },
      {
        key: slot('block', '2027-03-26T07:00:00.000Z'),
        start: '2027-03-26T07:00:00.000Z',
        end: '2027-03-26T08:00:00.000Z',
      },
    ],
  },
  {
    name: 'local-skipped',
    rows: [
      sundayBlock({ exceptions: [{ originalStart: '2026-11-08T11:00:00.000Z', skipped: true }] }),
    ],
    range: TWO_WEEKS,
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2026-11-01T11:00:00.000Z'),
        start: '2026-11-01T11:00:00.000Z',
        end: '2026-11-01T15:00:00.000Z',
      },
    ],
  },
  {
    // Sun 8 Nov moved to 14:00–17:00: the key stays the original slot's.
    name: 'local-moved',
    rows: [
      sundayBlock({
        exceptions: [
          {
            originalStart: '2026-11-08T11:00:00.000Z',
            startAt: '2026-11-08T12:00:00.000Z',
            endAt: '2026-11-08T15:00:00.000Z',
          },
        ],
      }),
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2026-11-08T11:00:00.000Z'),
        start: '2026-11-08T12:00:00.000Z',
        end: '2026-11-08T15:00:00.000Z',
      },
    ],
  },
  {
    // Sun 15 Nov (after the range) moved to Sat 14 Nov 10:00–12:00 (inside it).
    name: 'local-moved-into-range',
    rows: [
      sundayBlock({
        exceptions: [
          {
            originalStart: '2026-11-15T11:00:00.000Z',
            startAt: '2026-11-14T08:00:00.000Z',
            endAt: '2026-11-14T10:00:00.000Z',
          },
        ],
      }),
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2026-11-08T11:00:00.000Z'),
        start: '2026-11-08T11:00:00.000Z',
        end: '2026-11-08T15:00:00.000Z',
      },
      {
        key: slot('block', '2026-11-15T11:00:00.000Z'),
        start: '2026-11-14T08:00:00.000Z',
        end: '2026-11-14T10:00:00.000Z',
      },
    ],
  },
  {
    // Sun 8 Nov (inside the range) moved to Sat 7 Nov (before it); and an exception whose
    // original start is not a slot of the series is ignored.
    name: 'local-moved-out-of-range',
    rows: [
      sundayBlock({
        exceptions: [
          {
            originalStart: '2026-11-08T11:00:00.000Z',
            startAt: '2026-11-07T08:00:00.000Z',
            endAt: '2026-11-07T10:00:00.000Z',
          },
          {
            originalStart: '2026-11-10T11:00:00.000Z',
            startAt: '2026-11-10T12:00:00.000Z',
            endAt: '2026-11-10T13:00:00.000Z',
          },
        ],
      }),
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [],
  },
  {
    // First occurrence Sun 13 Sep 2026 (summer time): only this week's occurrence is listed.
    name: 'series-started-eight-weeks-ago',
    rows: [weeklyBlock('2026-09-13T10:00:00.000Z', '2026-09-13T14:00:00.000Z')],
    range: WEEK,
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2026-11-08T11:00:00.000Z'),
        start: '2026-11-08T11:00:00.000Z',
        end: '2026-11-08T15:00:00.000Z',
      },
    ],
  },
  {
    name: 'until-before-range',
    rows: [
      weeklyBlock(
        '2026-10-04T10:00:00.000Z',
        '2026-10-04T14:00:00.000Z',
        {},
        'RRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=20261101T000000Z',
      ),
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [],
  },
  {
    // A UTC UNTIL is an instant: exactly the Sun 8 Nov 13:00 slot's instant keeps that slot.
    name: 'until-at-last-slot',
    rows: [
      weeklyBlock(
        '2026-11-01T11:00:00.000Z',
        '2026-11-01T15:00:00.000Z',
        {},
        'RRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=20261108T110000Z',
      ),
    ],
    range: TWO_WEEKS,
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2026-11-01T11:00:00.000Z'),
        start: '2026-11-01T11:00:00.000Z',
        end: '2026-11-01T15:00:00.000Z',
      },
      {
        key: slot('block', '2026-11-08T11:00:00.000Z'),
        start: '2026-11-08T11:00:00.000Z',
        end: '2026-11-08T15:00:00.000Z',
      },
    ],
  },
  {
    // One second before the Sun 8 Nov 13:00 slot's instant: that slot is gone.
    name: 'until-one-second-before-last-slot',
    rows: [
      weeklyBlock(
        '2026-11-01T11:00:00.000Z',
        '2026-11-01T15:00:00.000Z',
        {},
        'RRULE:FREQ=WEEKLY;BYDAY=SU;UNTIL=20261108T105959Z',
      ),
    ],
    range: TWO_WEEKS,
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2026-11-01T11:00:00.000Z'),
        start: '2026-11-01T11:00:00.000Z',
        end: '2026-11-01T15:00:00.000Z',
      },
    ],
  },
  {
    // Every Friday 02:30–03:30 local. On Fri 26 Mar 2027 02:30 never happens (the clocks jump
    // to 03:00), so that slot is 03:30 summer time; it is moved to Thu 25 Mar 10:00–11:00, inside
    // the range, while its slot is outside it.
    name: 'dst-gap-slot-moved-into-range',
    rows: [
      weeklyBlock(
        '2027-03-19T00:30:00.000Z',
        '2027-03-19T01:30:00.000Z',
        {
          exceptions: [
            {
              originalStart: '2027-03-26T00:30:00.000Z',
              startAt: '2027-03-25T08:00:00.000Z',
              endAt: '2027-03-25T09:00:00.000Z',
            },
          ],
        },
        'RRULE:FREQ=WEEKLY;BYDAY=FR',
      ),
    ],
    range: { from: '2027-03-24T22:00:00.000Z', to: '2027-03-25T22:00:00.000Z' },
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2027-03-26T00:30:00.000Z'),
        start: '2027-03-25T08:00:00.000Z',
        end: '2027-03-25T09:00:00.000Z',
      },
    ],
  },
  {
    // One Google series mirrored through two accounts (one item copy per integration): two
    // masters share `calendarId|eventId`, so a moved row can't tell which is its master. Each
    // moved row keys on itself, and every key stays unique.
    name: 'google-series-mirrored-twice',
    rows: [
      { ...googleMaster, id: 'mirrorA', source: googleSource('mirrorA') },
      { ...googleMaster, id: 'mirrorB', source: googleSource('mirrorB') },
      ...['movedA', 'movedB'].map(
        (id): TimeRow => ({
          id,
          kind: 'event',
          title: 'Lecture',
          status: 'open',
          startAt: '2026-11-12T12:00:00.000Z',
          endAt: '2026-11-12T13:00:00.000Z',
          dueAt: null,
          allDay: false,
          source: googleSource(id),
          props: {
            calendarId: 'c',
            recurringEventId: 'e1',
            originalStartAt: '2026-11-12T08:00:00.000Z',
          },
        }),
      ),
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [
      {
        key: slot('mirrorA', '2026-11-08T08:00:00.000Z'),
        start: '2026-11-08T08:00:00.000Z',
        end: '2026-11-08T09:00:00.000Z',
      },
      {
        key: slot('mirrorB', '2026-11-08T08:00:00.000Z'),
        start: '2026-11-08T08:00:00.000Z',
        end: '2026-11-08T09:00:00.000Z',
      },
      {
        key: slot('mirrorA', '2026-11-10T08:00:00.000Z'),
        start: '2026-11-10T08:00:00.000Z',
        end: '2026-11-10T09:00:00.000Z',
      },
      {
        key: slot('mirrorB', '2026-11-10T08:00:00.000Z'),
        start: '2026-11-10T08:00:00.000Z',
        end: '2026-11-10T09:00:00.000Z',
      },
      {
        key: slot('movedA', '2026-11-12T08:00:00.000Z'),
        start: '2026-11-12T12:00:00.000Z',
        end: '2026-11-12T13:00:00.000Z',
      },
      {
        key: slot('movedB', '2026-11-12T08:00:00.000Z'),
        start: '2026-11-12T12:00:00.000Z',
        end: '2026-11-12T13:00:00.000Z',
      },
    ],
  },
  {
    // A rule that can't be read: the series' first occurrence alone.
    name: 'unreadable-rule',
    rows: [
      weeklyBlock(
        '2026-11-10T08:00:00.000Z',
        '2026-11-10T09:00:00.000Z',
        {},
        'RRULE:FREQ=SOMETIMES;BYDAY=SU',
      ),
    ],
    range: WEEK,
    timeZone: TZ,
    expected: [
      {
        key: slot('block', '2026-11-10T08:00:00.000Z'),
        start: '2026-11-10T08:00:00.000Z',
        end: '2026-11-10T09:00:00.000Z',
      },
    ],
  },
];
