/**
 * Sample data for the landing page: one student who also works, around the visitor's current
 * day. Titles are data, not interface text, so each carries its own English and Hebrew instead of
 * going through i18n. Times are local wall times in the visitor's own time zone.
 */
import type { Provider } from '../../components/items/types.ts';

/** One event on the sample day; the same shape as the clock block's DemoEvent. */
export interface DemoEvent {
  id: string;
  title: string;
  start: Date;
  end: Date;
  source: Provider;
}

export type DemoLanguage = 'en' | 'he';

interface Text {
  en: string;
  he: string;
}

export function demoLanguage(language: string): DemoLanguage {
  return language.startsWith('he') ? 'he' : 'en';
}

/** Local time `days` after today at `hour:minute`. */
function at(now: Date, days: number, hour: number, minute = 0): Date {
  return new Date(now.getFullYear(), now.getMonth(), now.getDate() + days, hour, minute);
}

interface EventSeed {
  id: string;
  source: Provider;
  start: [hour: number, minute: number];
  end: [hour: number, minute: number];
  title: Text;
}

const ALGEBRA: EventSeed = {
  id: 'algebra',
  source: 'moodle',
  start: [8, 30],
  end: [10, 0],
  title: { en: 'Linear algebra lecture', he: 'הרצאה באלגברה לינארית' },
};
const TUTORIAL: EventSeed = {
  id: 'tutorial',
  source: 'moodle',
  start: [10, 15],
  end: [11, 45],
  title: { en: 'Data structures tutorial', he: 'תרגול במבני נתונים' },
};
const STANDUP: EventSeed = {
  id: 'standup',
  source: 'google_calendar',
  start: [13, 0],
  end: [13, 30],
  title: { en: 'Team stand-up', he: 'פגישת צוות' },
};
const WORK: EventSeed = {
  id: 'refunds',
  source: 'jira',
  start: [13, 30],
  end: [17, 30],
  title: { en: 'PAY-142 Refund flow', he: 'PAY-142 תהליך החזר כספי' },
};
const GYM: EventSeed = {
  id: 'gym',
  source: 'google_calendar',
  start: [19, 0],
  end: [20, 0],
  title: { en: 'Gym', he: 'חדר כושר' },
};
const QUIZ: EventSeed = {
  id: 'quiz',
  source: 'moodle',
  start: [21, 0],
  end: [22, 30],
  title: { en: 'Quiz 3 is open', he: 'בוחן 3 פתוח' },
};
const PROBABILITY: EventSeed = {
  id: 'probability',
  source: 'moodle',
  start: [8, 30],
  end: [10, 0],
  title: { en: 'Probability lecture', he: 'הרצאה בהסתברות' },
};

/** A full weekday: classes in the morning, work in the afternoon, the evening for the rest. */
const DAY: readonly EventSeed[] = [ALGEBRA, TUTORIAL, STANDUP, WORK, GYM, QUIZ];

function toEvent(seed: EventSeed, now: Date, days: number, lang: DemoLanguage): DemoEvent {
  return {
    id: days === 0 ? seed.id : `${seed.id}-${String(days)}`,
    title: seed.title[lang],
    source: seed.source,
    start: at(now, days, ...seed.start),
    end: at(now, days, ...seed.end),
  };
}

/** Today's events, plus tomorrow's first one so there is always a "next". */
export function demoDayEvents(now: Date, lang: DemoLanguage): DemoEvent[] {
  return [...DAY.map((seed) => toEvent(seed, now, 0, lang)), toEvent(PROBABILITY, now, 1, lang)];
}

/** The rest of the week (Sunday to Saturday) for the calendar; today is the full day above. */
const WEEK_PATTERN: Record<number, readonly EventSeed[]> = {
  0: [ALGEBRA, TUTORIAL, GYM],
  1: [PROBABILITY, STANDUP, WORK],
  2: [ALGEBRA, TUTORIAL, WORK, GYM],
  3: [PROBABILITY, STANDUP, WORK],
  4: [ALGEBRA, TUTORIAL, GYM, QUIZ],
  5: [
    {
      id: 'dinner',
      source: 'google_calendar',
      start: [19, 30],
      end: [21, 30],
      title: { en: 'Family dinner', he: 'ארוחת ערב משפחתית' },
    },
  ],
  6: [
    {
      id: 'study-group',
      source: 'google_calendar',
      start: [18, 0],
      end: [20, 0],
      title: { en: 'Study group', he: 'קבוצת לימוד' },
    },
  ],
};

/** Events for the seven days of the current week, starting on Sunday. */
export function demoWeekEvents(now: Date, lang: DemoLanguage): DemoEvent[] {
  const today = now.getDay();
  const events: DemoEvent[] = [];
  for (let weekday = 0; weekday < 7; weekday += 1) {
    const days = weekday - today;
    if (days === 0) {
      events.push(...DAY.map((seed) => toEvent(seed, now, 0, lang)));
    } else {
      events.push(...(WEEK_PATTERN[weekday] ?? []).map((seed) => toEvent(seed, now, days, lang)));
    }
  }
  return events;
}

export interface DemoDeadline {
  id: string;
  title: string;
  context: string;
  source: Provider;
  due: Date;
}

interface DeadlineSeed {
  id: string;
  source: Provider;
  due: [days: number, hour: number, minute: number];
  title: Text;
  context: Text;
}

const DEADLINES: DeadlineSeed[] = [
  {
    id: 'lab-report',
    source: 'moodle',
    due: [-1, 23, 59],
    title: { en: 'Lab report 2', he: 'דוח מעבדה 2' },
    context: { en: 'Physics 1', he: 'פיזיקה 1' },
  },
  {
    id: 'review',
    source: 'github',
    due: [1, 12, 0],
    title: { en: 'Review pull request 48', he: 'סקירה של בקשת מיזוג 48' },
    context: { en: 'shop-app', he: 'shop-app' },
  },
  {
    id: 'exercise',
    source: 'moodle',
    due: [2, 23, 59],
    title: { en: 'Exercise 4: graphs', he: 'תרגיל 4: גרפים' },
    context: { en: 'Data structures', he: 'מבני נתונים' },
  },
  {
    id: 'release-notes',
    source: 'jira',
    due: [3, 17, 0],
    title: { en: 'PAY-150 Release notes', he: 'PAY-150 הערות גרסה' },
    context: { en: 'Payments', he: 'תשלומים' },
  },
  {
    id: 'contact-form',
    source: 'linear',
    due: [4, 18, 0],
    title: { en: 'Validate the contact form', he: 'בדיקות לטופס יצירת קשר' },
    context: { en: 'Portfolio site', he: 'אתר תיק עבודות' },
  },
  {
    id: 'hours',
    source: 'clickup',
    due: [6, 12, 0],
    title: { en: 'Send monthly hours', he: 'שליחת דיווח שעות חודשי' },
    context: { en: 'Studio work', he: 'עבודה בסטודיו' },
  },
];

/** Every sample deadline, overdue first, then soonest first. */
export function demoDeadlines(now: Date, lang: DemoLanguage): DemoDeadline[] {
  return DEADLINES.map((seed) => ({
    id: seed.id,
    title: seed.title[lang],
    context: seed.context[lang],
    source: seed.source,
    due: at(now, ...seed.due),
  })).sort((a, b) => a.due.getTime() - b.due.getTime());
}

/** The next `count` deadlines that are not overdue. */
export function demoUpcomingDeadlines(
  now: Date,
  lang: DemoLanguage,
  count: number,
): DemoDeadline[] {
  return demoDeadlines(now, lang)
    .filter((deadline) => deadline.due.getTime() >= now.getTime())
    .slice(0, count);
}

export interface DemoTask {
  id: string;
  title: string;
  due: Date;
  done: boolean;
}

const TASKS: { id: string; due: [number, number, number]; done: boolean; title: Text }[] = [
  {
    id: 'cable',
    due: [0, 18, 0],
    done: false,
    title: { en: 'Buy a USB-C cable', he: 'לקנות כבל USB-C' },
  },
  {
    id: 'email-ta',
    due: [1, 10, 0],
    done: false,
    title: { en: 'Email the TA about the lab', he: 'לכתוב למתרגל על המעבדה' },
  },
  {
    id: 'student-card',
    due: [3, 12, 0],
    done: true,
    title: { en: 'Renew student card', he: 'לחדש כרטיס סטודנט' },
  },
];

export function demoTasks(now: Date, lang: DemoLanguage): DemoTask[] {
  return TASKS.map((seed) => ({
    id: seed.id,
    title: seed.title[lang],
    due: at(now, ...seed.due),
    done: seed.done,
  }));
}

export interface DemoCard {
  id: string;
  title: string;
  source: Provider;
  reference: string;
  due?: Date;
  assignee?: string;
}

export function demoBoard(now: Date, lang: DemoLanguage): { todo: DemoCard[]; doing: DemoCard[] } {
  const maya = { en: 'Maya Klein', he: 'מאיה קליין' }[lang];
  const you = { en: 'Yuval Ben Ami', he: 'יובל בן עמי' }[lang];
  return {
    todo: [
      {
        id: 'pay-151',
        title: { en: 'Show refund status on receipts', he: 'הצגת סטטוס ההחזר בקבלות' }[lang],
        source: 'jira',
        reference: 'PAY-151',
        due: at(now, 2, 17),
        assignee: maya,
      },
      {
        id: 'web-12',
        title: { en: 'Dark mode for the portfolio site', he: 'מצב כהה לאתר תיק העבודות' }[lang],
        source: 'linear',
        reference: 'WEB-12',
      },
    ],
    doing: [
      {
        id: 'pay-142',
        title: { en: 'Refund flow for annual plans', he: 'תהליך החזר למנויים שנתיים' }[lang],
        source: 'jira',
        reference: 'PAY-142',
        due: at(now, 1, 17),
        assignee: you,
      },
    ],
  };
}

/** Open to-dos per source, for the counter block. */
export const DEMO_OPEN_TODOS: readonly { source: Provider; count: number }[] = [
  { source: 'jira', count: 5 },
  { source: 'moodle', count: 4 },
  { source: 'github', count: 2 },
  { source: 'linear', count: 2 },
  { source: 'clickup', count: 1 },
  { source: 'local', count: 3 },
];

export interface DemoMember {
  id: string;
  name: string;
  role: 'owner' | 'editor' | 'viewer';
  scope: 'all' | 'college';
}

export function demoMembers(lang: DemoLanguage): DemoMember[] {
  const people: { id: string; name: Text; role: DemoMember['role']; scope: DemoMember['scope'] }[] =
    [
      {
        id: 'yuval',
        name: { en: 'Yuval Ben Ami', he: 'יובל בן עמי' },
        role: 'owner',
        scope: 'all',
      },
      { id: 'noa', name: { en: 'Noa Levi', he: 'נועה לוי' }, role: 'editor', scope: 'all' },
      { id: 'amit', name: { en: 'Amit Cohen', he: 'עמית כהן' }, role: 'viewer', scope: 'college' },
      {
        id: 'dana',
        name: { en: 'Dana Mizrahi', he: 'דנה מזרחי' },
        role: 'viewer',
        scope: 'college',
      },
    ];
  return people.map((person) => ({ ...person, name: person.name[lang] }));
}

export function demoWorkspaceName(lang: DemoLanguage): string {
  return { en: 'Year 2 study group', he: 'קבוצת לימוד שנה ב׳' }[lang];
}

export function demoAgentChat(lang: DemoLanguage): { question: string; answer: string } {
  return {
    question: { en: 'What’s due this week?', he: 'מה צריך להגיש השבוע?' }[lang],
    answer: {
      en: 'Three things in the next few days. Start with the review: it’s due tomorrow at noon.',
      he: 'שלושה דברים בימים הקרובים. כדאי להתחיל מהסקירה: צריך להגיש אותה מחר בצהריים.',
    }[lang],
  };
}

export const DEMO_CONNECTION = {
  source: 'jira',
  account: 'shop-team.atlassian.net',
  syncedMinutesAgo: 4,
} as const;
