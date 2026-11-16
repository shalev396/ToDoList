/**
 * Topics (PERMISSIONS-V2 "Dynamic topics", NEXT-FEATURES D2): the pages of a workspace, as data.
 * A topic has a free-text name and a standardized slug, unique in its workspace, that its URL
 * (`/t/<slug>`) uses. Work, College and Personal are only the defaults a workspace starts with.
 *
 * Shared by the server and the client (`@api-types/topics`): pure TypeScript, no imports.
 */

export const TOPIC_NAME_MAX = 60;
/** In characters (code points), not bytes: a Hebrew slug is as long as its name. */
export const TOPIC_SLUG_MAX = 48;
/** Topics one workspace may hold. */
export const TOPICS_PER_WORKSPACE_MAX = 50;

/** The icons a topic may name (the client maps each to its own glyph). */
export const TOPIC_ICONS = [
  'briefcase',
  'graduation-cap',
  'leaf',
  'folder',
  'star',
  'heart',
  'home',
  'book',
  'code',
  'users',
  'building',
  'plane',
] as const;
export type TopicIcon = (typeof TOPIC_ICONS)[number];

/** The colours a topic may name: tones of the app's palette, so both themes can draw them. */
export const TOPIC_COLOURS = [
  'gray',
  'red',
  'orange',
  'amber',
  'green',
  'teal',
  'blue',
  'violet',
  'pink',
] as const;
export type TopicColour = (typeof TOPIC_COLOURS)[number];

/** The slugs of the default topics: the areas every workspace had before topics existed. */
export const DEFAULT_TOPIC_SLUGS = ['work', 'college', 'personal'] as const;
export type DefaultTopicSlug = (typeof DEFAULT_TOPIC_SLUGS)[number];

export interface DefaultTopic {
  slug: DefaultTopicSlug;
  icon: TopicIcon;
  /** The name a new workspace gives it, in the creator's language. */
  names: { en: string; he: string };
}

/** In their default order. */
export const DEFAULT_TOPICS: readonly DefaultTopic[] = [
  { slug: 'work', icon: 'briefcase', names: { en: 'Work', he: 'עבודה' } },
  { slug: 'college', icon: 'graduation-cap', names: { en: 'College', he: 'לימודים' } },
  { slug: 'personal', icon: 'leaf', names: { en: 'Personal', he: 'אישי' } },
];

export function isDefaultTopicSlug(value: string): value is DefaultTopicSlug {
  return (DEFAULT_TOPIC_SLUGS as readonly string[]).includes(value);
}

/** The slug a name that has no letters or digits at all gets (say, only emoji). */
const FALLBACK_SLUG = 'topic';

/**
 * The standardized slug of a topic name: lower case, accents and other marks dropped (Café →
 * cafe; Hebrew points too), every run of characters that are not letters or digits turned into
 * one hyphen, no hyphen at either end, at most TOPIC_SLUG_MAX characters. Letters of any script
 * stay, so a Hebrew name keeps a Hebrew slug. A name without letters or digits gets `topic`.
 */
export function standardizeTopicSlug(name: string): string {
  const dashed = name
    .normalize('NFKD')
    .replace(/\p{M}+/gu, '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, '-')
    .replace(/^-+|-+$/g, '');
  const cut = Array.from(dashed).slice(0, TOPIC_SLUG_MAX).join('').replace(/-+$/, '');
  return cut === '' ? FALLBACK_SLUG : cut;
}

/** Whether `value` is a standardized slug (what standardizeTopicSlug gives back unchanged). */
export function isTopicSlug(value: string): boolean {
  return value !== '' && standardizeTopicSlug(value) === value;
}

/**
 * `base`, or `base-2`, `base-3`… : the first one not in `taken`, still at most TOPIC_SLUG_MAX
 * characters (the base is cut to make room for the suffix).
 */
export function uniqueTopicSlug(base: string, taken: ReadonlySet<string>): string {
  if (!taken.has(base)) return base;
  const chars = Array.from(base);
  for (let n = 2; ; n += 1) {
    const suffix = `-${String(n)}`;
    const stem = chars
      .slice(0, TOPIC_SLUG_MAX - suffix.length)
      .join('')
      .replace(/-+$/, '');
    const candidate = `${stem}${suffix}`;
    if (!taken.has(candidate)) return candidate;
  }
}
