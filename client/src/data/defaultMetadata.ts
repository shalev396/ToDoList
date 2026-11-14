import { app } from './app';

/**
 * Default page metadata. Sync with index.html for no-JS fallback (crawlers, disabled JS).
 * PageMetadata merges these with per-page overrides.
 */
export const DEFAULT_METADATA = {
  title: 'TodoList',
  description:
    'TodoList puts Moodle, Jira, ClickUp, Linear, GitHub, Google Calendar and Google Drive on one dashboard: what’s on now, what’s next and every deadline this week. Free for students who also work.',
  keywords:
    'todo list, students, deadlines, calendar, moodle, jira, clickup, linear, github, dashboard',
  author: 'TodoList',
  image: '/og-default.png',
  robots: 'index, follow' as const,
  ogType: 'website',
  twitterCard: 'summary_large_image',
} as const;

/** Open Graph locale per UI language (og:locale). Unknown languages fall back to en_US. */
export const OG_LOCALES: Record<string, string> = {
  en: 'en_US',
  he: 'he_IL',
};

export function getOgLocale(language: string): string {
  const base = language.split('-')[0] ?? language;
  return OG_LOCALES[base] ?? 'en_US';
}

/** Base URL for canonical and og:url. Use VITE_APP_URL if set, else origin at build time. */
export function getBaseUrl(): string {
  return app.baseUrl;
}
