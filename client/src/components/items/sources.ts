import type { Provider } from './types.ts';

/**
 * Source colours follow the fixed slots in docs/design/DESIGN.md: colour follows the source,
 * never its rank, and segments are drawn in slot order. Local to-dos ("Your to-dos") take
 * their own sky cyan, --source-local; reserved providers (slack, notion) have none and stay muted.
 */
export const SOURCE_SLOT_ORDER: readonly Provider[] = [
  'jira',
  'moodle',
  'google_calendar',
  'clickup',
  'github',
  'linear',
  'local',
];

interface SourceStyle {
  /** Background utility, for dots and bar segments. */
  bg: string;
  /** SVG fill utility, for ring arcs. */
  fill: string;
  /** A light wash of the colour, for large areas such as calendar events. */
  wash: string;
  /** Border colour utility, for the solid edge that goes with a wash. */
  edge: string;
}

// Full class names, written out so Tailwind finds them when it scans the source.
export const SOURCE_STYLES: Record<Provider, SourceStyle> = {
  jira: {
    bg: 'bg-source-jira',
    fill: 'fill-source-jira',
    wash: 'bg-source-jira/15 dark:bg-source-jira/25',
    edge: 'border-source-jira',
  },
  moodle: {
    bg: 'bg-source-moodle',
    fill: 'fill-source-moodle',
    wash: 'bg-source-moodle/15 dark:bg-source-moodle/25',
    edge: 'border-source-moodle',
  },
  google_calendar: {
    bg: 'bg-source-google-calendar',
    fill: 'fill-source-google-calendar',
    wash: 'bg-source-google-calendar/15 dark:bg-source-google-calendar/25',
    edge: 'border-source-google-calendar',
  },
  clickup: {
    bg: 'bg-source-clickup',
    fill: 'fill-source-clickup',
    wash: 'bg-source-clickup/15 dark:bg-source-clickup/25',
    edge: 'border-source-clickup',
  },
  github: {
    bg: 'bg-source-github',
    fill: 'fill-source-github',
    wash: 'bg-source-github/15 dark:bg-source-github/25',
    edge: 'border-source-github',
  },
  linear: {
    bg: 'bg-source-linear',
    fill: 'fill-source-linear',
    wash: 'bg-source-linear/15 dark:bg-source-linear/25',
    edge: 'border-source-linear',
  },
  local: {
    bg: 'bg-source-local',
    fill: 'fill-source-local',
    wash: 'bg-source-local/15 dark:bg-source-local/25',
    edge: 'border-source-local',
  },
};

/** Providers with no slot of their own (slack, notion, a future source): the muted ink. */
export const RESERVED_SOURCE_STYLE = { fill: 'fill-source-reserved', bg: 'bg-source-reserved' };

/**
 * The source's colour as a CSS value, for code that paints at run time (a chart segment). The
 * variable is always defined: index.css writes every source colour out (`@theme … static`).
 */
export function sourceColourVar(source: Provider): string {
  return `var(--color-source-${source.replaceAll('_', '-')})`;
}

/** Sort comparator that puts sources in slot order. */
export function bySlot(a: Provider, b: Provider): number {
  return SOURCE_SLOT_ORDER.indexOf(a) - SOURCE_SLOT_ORDER.indexOf(b);
}

/** The i18n key of a source's display name. */
export function sourceNameKey(source: Provider): string {
  return `sources.${source}`;
}
