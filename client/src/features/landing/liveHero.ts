/**
 * The hero's live sample: every LIVE_INTERVAL_MS one step of a fixed script of 40 happens on the
 * clock and the deadline list (a deadline is added, one is marked done, an event lands or moves).
 * The script and the reducer are plain data and pure functions, so they are unit tested; the
 * hook that plays them is useLiveHero. Titles are sample data, so each carries English and Hebrew.
 */
import type { Provider } from '../../components/items/types.ts';
import type { DemoDeadline, DemoEvent, DemoLanguage } from './demoData.ts';

export const LIVE_INTERVAL_MS = 30_000;
/** How many deadlines the hero lists. */
export const LIVE_DEADLINES = 4;

interface Text {
  en: string;
  he: string;
}

type When = readonly [days: number, hour: number, minute: number];
type Clock = readonly [hour: number, minute: number];

export type LiveStep =
  | {
      kind: 'deadline';
      ref: string;
      source: Provider;
      title: Text;
      context: Text;
      due: When;
    }
  | { kind: 'done'; ref: string }
  | { kind: 'event'; ref: string; source: Provider; title: Text; start: Clock; minutes: number }
  | { kind: 'moved'; ref: string; start: Clock };

const deadline = (
  ref: string,
  source: Provider,
  title: Text,
  context: Text,
  due: When,
): LiveStep => ({ kind: 'deadline', ref, source, title, context, due });
const done = (ref: string): LiveStep => ({ kind: 'done', ref });
const event = (
  ref: string,
  source: Provider,
  title: Text,
  start: Clock,
  minutes: number,
): LiveStep => ({ kind: 'event', ref, source, title, start, minutes });
const moved = (ref: string, start: Clock): LiveStep => ({ kind: 'moved', ref, start });

const text = (en: string, he: string): Text => ({ en, he });

const DATA_STRUCTURES = text('Data structures', 'מבני נתונים');
const PROBABILITY = text('Probability', 'הסתברות');
const PHYSICS = text('Physics 1', 'פיזיקה 1');
const ADMISSIONS = text('Admissions', 'קבלה');
const SHOP = text('shop-app', 'shop-app');
const PORTFOLIO = text('Portfolio site', 'אתר תיק עבודות');
const STUDIO = text('Studio work', 'עבודה בסטודיו');
const PAYMENTS = text('Payments', 'תשלומים');

/** 18 deadlines added, 14 marked done, 4 events landing and 4 moving: 40 steps, then it loops. */
export const LIVE_SCRIPT: readonly LiveStep[] = [
  deadline('quiz-2', 'moodle', text('Quiz 2', 'בוחן 2'), DATA_STRUCTURES, [0, 22, 0]),
  event(
    'lunch',
    'google_calendar',
    text('Lunch with the team', 'ארוחת צהריים עם הצוות'),
    [12, 0],
    45,
  ),
  deadline(
    'ads-12',
    'jira',
    text('ADS-12 Search filter', 'ADS-12 מסנן חיפוש'),
    ADMISSIONS,
    [1, 9, 0],
  ),
  done('review'),
  deadline(
    'pr-52',
    'github',
    text('Review pull request 52', 'סקירה של בקשת מיזוג 52'),
    SHOP,
    [1, 11, 0],
  ),
  done('quiz-2'),
  moved('lunch', [12, 30]),
  deadline(
    'web-14',
    'linear',
    text('WEB-14 Footer links', 'WEB-14 קישורי תחתית'),
    PORTFOLIO,
    [1, 15, 0],
  ),
  deadline(
    'proposal',
    'clickup',
    text('Project proposal draft', 'טיוטת הצעת פרויקט'),
    text('Software studio', 'סדנת תוכנה'),
    [2, 12, 0],
  ),
  done('ads-12'),
  event('study', 'google_calendar', text('Study session', 'מפגש לימוד'), [18, 0], 60),
  deadline('lab-3', 'moodle', text('Lab report 3', 'דוח מעבדה 3'), PHYSICS, [1, 23, 59]),
  done('pr-52'),
  deadline(
    'pay-155',
    'jira',
    text('PAY-155 Retry failed refunds', 'PAY-155 ניסיון חוזר להחזרים'),
    PAYMENTS,
    [1, 14, 0],
  ),
  deadline(
    'invoice',
    'clickup',
    text('Send the March invoice', 'שליחת חשבונית מרץ'),
    STUDIO,
    [2, 10, 0],
  ),
  moved('study', [18, 30]),
  done('lab-3'),
  deadline(
    'ex-5',
    'moodle',
    text('Exercise 5: trees', 'תרגיל 5: עצים'),
    DATA_STRUCTURES,
    [1, 20, 0],
  ),
  done('web-14'),
  event('call', 'google_calendar', text('Call with the client', 'שיחה עם הלקוח'), [20, 15], 40),
  deadline(
    'pr-53',
    'github',
    text('Fix flaky checkout test', 'תיקון בדיקה לא יציבה בקופה'),
    SHOP,
    [1, 13, 0],
  ),
  done('proposal'),
  deadline(
    'web-15',
    'linear',
    text('WEB-15 Image sizes', 'WEB-15 גדלי תמונות'),
    PORTFOLIO,
    [2, 16, 0],
  ),
  deadline(
    'notes',
    'linear',
    text('Lecture notes, week 6', 'סיכום הרצאות, שבוע 6'),
    text('Linear algebra', 'אלגברה לינארית'),
    [2, 18, 0],
  ),
  moved('call', [20, 45]),
  done('pay-155'),
  deadline('quiz-3', 'moodle', text('Quiz 3', 'בוחן 3'), PROBABILITY, [1, 21, 0]),
  done('invoice'),
  deadline(
    'ads-14',
    'jira',
    text('ADS-14 Export to CSV', 'ADS-14 ייצוא ל-CSV'),
    ADMISSIONS,
    [2, 11, 0],
  ),
  event('climb', 'google_calendar', text('Climbing', 'טיפוס'), [23, 0], 40),
  done('ex-5'),
  deadline(
    'hours',
    'clickup',
    text('Send weekly hours', 'שליחת דיווח שעות שבועי'),
    STUDIO,
    [2, 9, 0],
  ),
  done('pr-53'),
  deadline('pr-54', 'github', text('Update the README', 'עדכון ה-README'), SHOP, [2, 14, 0]),
  moved('climb', [22, 45]),
  done('quiz-3'),
  deadline('prob-set', 'moodle', text('Problem set 6', 'סדרת תרגילים 6'), PROBABILITY, [1, 19, 0]),
  done('web-15'),
  done('notes'),
  deadline(
    'web-16',
    'linear',
    text('WEB-16 Contact page copy', 'WEB-16 טקסט לדף יצירת קשר'),
    PORTFOLIO,
    [2, 17, 0],
  ),
];

export interface LiveItem extends DemoDeadline {
  done: boolean;
}

export interface LiveEvent extends DemoEvent {
  /** Set when the step just played added or moved this event, for a moment of emphasis. */
  fresh?: boolean;
}

export interface LiveChange {
  kind: LiveStep['kind'];
  source: Provider;
  title: string;
  ref: string;
}

export interface LiveState {
  /** How many steps have played. */
  step: number;
  deadlines: LiveItem[];
  /** Events the script added to today's clock. */
  events: LiveEvent[];
  /** The step just played, for the status line; null before the first or when a step did not apply. */
  last: LiveChange | null;
}

function at(now: Date, days: number, hour: number, minute: number): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute);
}

/** The state before any step: the sample deadlines the page already shows, no script events. */
export function initialLiveState(base: readonly DemoDeadline[]): LiveState {
  return {
    step: 0,
    deadlines: base.map((item) => ({ ...item, done: false })),
    events: [],
    last: null,
  };
}

/**
 * Plays the next script step. A deadline marked done by the previous step is dropped first, so it
 * stays on screen, struck through, until the next change. A step whose item is gone changes
 * nothing. At the start of every loop the script's own items are cleared, so the page returns to
 * its sample.
 */
export function applyLiveStep(
  state: LiveState,
  base: readonly DemoDeadline[],
  now: Date,
  lang: DemoLanguage,
): LiveState {
  const index = state.step % LIVE_SCRIPT.length;
  const step = LIVE_SCRIPT[index];
  const next = state.step + 1;
  if (!step) {
    return { ...state, step: next };
  }
  const start = index === 0 ? initialLiveState(base) : state;
  const deadlines = start.deadlines.filter((item) => !item.done);
  const events = start.events.map((item) => ({ ...item, fresh: false }));

  if (step.kind === 'deadline') {
    const item: LiveItem = {
      id: step.ref,
      title: step.title[lang],
      context: step.context[lang],
      source: step.source,
      due: at(now, ...step.due),
      done: false,
    };
    return {
      step: next,
      deadlines: [...deadlines, item],
      events,
      last: { kind: 'deadline', source: item.source, title: item.title, ref: item.id },
    };
  }
  if (step.kind === 'done') {
    const target = deadlines.find((item) => item.id === step.ref);
    if (!target) {
      return { step: next, deadlines, events, last: null };
    }
    return {
      step: next,
      deadlines: deadlines.map((item) => (item === target ? { ...item, done: true } : item)),
      events,
      last: { kind: 'done', source: target.source, title: target.title, ref: target.id },
    };
  }
  if (step.kind === 'event') {
    const begin = at(now, 0, ...step.start);
    const added: LiveEvent = {
      id: step.ref,
      title: step.title[lang],
      source: step.source,
      start: begin,
      end: new Date(begin.getTime() + step.minutes * 60_000),
      fresh: true,
    };
    return {
      step: next,
      deadlines,
      events: [...events, added],
      last: { kind: 'event', source: added.source, title: added.title, ref: added.id },
    };
  }
  const target = events.find((item) => item.id === step.ref);
  if (!target) {
    return { step: next, deadlines, events, last: null };
  }
  const length = target.end.getTime() - target.start.getTime();
  const begin = at(now, 0, ...step.start);
  const shifted: LiveEvent = {
    ...target,
    start: begin,
    end: new Date(begin.getTime() + length),
    fresh: true,
  };
  return {
    step: next,
    deadlines,
    events: events.map((item) => (item === target ? shifted : item)),
    last: { kind: 'moved', source: target.source, title: target.title, ref: target.id },
  };
}

/** The deadlines to list: the soonest not-overdue ones, finished ones included until dropped. */
export function visibleDeadlines(state: LiveState, now: Date): LiveItem[] {
  return state.deadlines
    .filter((item) => item.due.getTime() >= now.getTime())
    .sort((a, b) => a.due.getTime() - b.due.getTime())
    .slice(0, LIVE_DEADLINES);
}
