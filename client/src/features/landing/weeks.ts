/**
 * Two sample weeks for "Built for everyone": a light student week, and a packed one (two jobs,
 * studies and a side project). Same app, same blocks, different data. Days run Sunday (0) to
 * Saturday (6), like the calendar block. Nothing overlaps, so each bar stands alone.
 */
import type { Provider } from '../../components/items/types.ts';
import type { DemoEvent, DemoLanguage } from './demoData.ts';

export type WeekKind = 'light' | 'packed';

type Clock = readonly [hour: number, minute: number];

interface Seed {
  day: number;
  source: Provider;
  start: Clock;
  end: Clock;
  en: string;
  he: string;
}

const seed = (
  day: number,
  source: Provider,
  start: Clock,
  end: Clock,
  en: string,
  he: string,
): Seed => ({ day, source, start, end, en, he });

const LIGHT: readonly Seed[] = [
  seed(0, 'moodle', [9, 0], [10, 30], 'Algebra lecture', 'הרצאה באלגברה'),
  seed(0, 'google_calendar', [18, 0], [19, 0], 'Gym', 'חדר כושר'),
  seed(1, 'moodle', [10, 0], [11, 30], 'Data structures tutorial', 'תרגול במבני נתונים'),
  seed(2, 'moodle', [9, 0], [10, 30], 'Probability lecture', 'הרצאה בהסתברות'),
  seed(2, 'google_calendar', [17, 0], [19, 0], 'Study group', 'קבוצת לימוד'),
  seed(3, 'moodle', [9, 0], [10, 30], 'Algebra lecture', 'הרצאה באלגברה'),
  seed(4, 'moodle', [21, 0], [22, 0], 'Quiz 3 is open', 'בוחן 3 פתוח'),
  seed(5, 'google_calendar', [19, 30], [21, 30], 'Family dinner', 'ארוחת ערב משפחתית'),
];

const CLASSES: readonly Seed[] = [0, 1, 2, 3, 4].flatMap((day) => [
  seed(day, 'moodle', [8, 30], [10, 0], 'Lecture', 'הרצאה'),
  seed(day, 'moodle', [10, 15], [11, 45], 'Tutorial', 'תרגול'),
]);

const PACKED: readonly Seed[] = [
  ...CLASSES,
  ...[0, 1, 2, 3, 4].map((day) =>
    seed(day, 'jira', [12, 30], [16, 30], 'Payments team', 'צוות תשלומים'),
  ),
  ...[0, 2, 4].map((day) =>
    seed(day, 'clickup', [17, 0], [19, 0], 'Studio shift', 'משמרת בסטודיו'),
  ),
  ...[1, 3].map((day) =>
    seed(day, 'linear', [19, 30], [21, 30], 'Portfolio site', 'אתר תיק עבודות'),
  ),
  seed(5, 'github', [10, 0], [13, 0], 'Open-source fixes', 'תיקונים בקוד פתוח'),
  seed(5, 'google_drive', [14, 0], [17, 0], 'Thesis draft', 'טיוטת עבודת גמר'),
  seed(6, 'clickup', [10, 0], [15, 0], 'Studio shift', 'משמרת בסטודיו'),
  seed(6, 'linear', [17, 0], [20, 0], 'Portfolio site', 'אתר תיק עבודות'),
];

/** The events of the chosen week, for the seven days of the week that contains `now`. */
export function weekEvents(kind: WeekKind, now: Date, lang: DemoLanguage): DemoEvent[] {
  const seeds = kind === 'light' ? LIGHT : PACKED;
  return seeds.map((item, index) => {
    const date = new Date(
      now.getFullYear(),
      now.getMonth(),
      now.getDate() - now.getDay() + item.day,
    );
    return {
      id: `${kind}-${String(index)}`,
      title: item[lang],
      source: item.source,
      start: new Date(date.getFullYear(), date.getMonth(), date.getDate(), ...item.start),
      end: new Date(date.getFullYear(), date.getMonth(), date.getDate(), ...item.end),
    };
  });
}

export interface WeekSummary {
  events: number;
  sources: number;
  hours: number;
}

/** How full the week is, for the line under the calendar. */
export function summarizeWeek(events: readonly DemoEvent[]): WeekSummary {
  const minutes = events.reduce(
    (sum, event) => sum + (event.end.getTime() - event.start.getTime()) / 60_000,
    0,
  );
  return {
    events: events.length,
    sources: new Set(events.map((event) => event.source)).size,
    hours: Math.round(minutes / 60),
  };
}
