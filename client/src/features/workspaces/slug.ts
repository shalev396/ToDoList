/**
 * Workspace slugs, as the create form previews them. The rules and the name-to-slug steps mirror
 * server/src/services/workspaces.ts (SLUG_MIN, SLUG_MAX, SLUG_PATTERN, slugBaseFromName); the
 * server still checks format and uniqueness, so the preview can only be wrong about a taken slug.
 */

export const SLUG_MIN = 2;
export const SLUG_MAX = 48;
/** A generated slug stops here on the server, leaving room for a "-<n>" suffix. */
const SLUG_BASE_MAX = 40;
/** Lowercase letters and digits in groups joined by single hyphens. */
export const SLUG_PATTERN = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;
const SLUG_ALPHABET = 'abcdefghijklmnopqrstuvwxyz0123456789';

/**
 * The slug the server derives from a name: accents dropped, every other run of characters a
 * hyphen. Null when the name has too little Latin in it (a Hebrew name, say); the server then picks
 * `workspace-<6 random characters>`.
 */
export function slugFromName(name: string): string | null {
  const base = name
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, SLUG_BASE_MAX)
    .replace(/-+$/, '');
  return base.length >= SLUG_MIN ? base : null;
}

/**
 * What someone types into the slug field, tidied as they type: lowercase, spaces and underscores
 * become hyphens, anything else outside a–z, 0–9 and the hyphen goes, and hyphens never double. A
 * trailing hyphen stays, so "my-" can become "my-workspace".
 */
export function tidySlugInput(value: string): string {
  return value
    .toLowerCase()
    .replace(/[\s_]+/g, '-')
    .replace(/[^a-z0-9-]/g, '')
    .replace(/-{2,}/g, '-')
    .replace(/^-+/, '')
    .slice(0, SLUG_MAX);
}

export function isValidSlug(slug: string): boolean {
  return slug.length >= SLUG_MIN && slug.length <= SLUG_MAX && SLUG_PATTERN.test(slug);
}

/** `workspace-` and six random letters or digits, like the server's fallback. */
export function randomWorkspaceSlug(random: () => number = Math.random): string {
  let suffix = '';
  for (let i = 0; i < 6; i += 1) {
    suffix += SLUG_ALPHABET.charAt(Math.floor(random() * SLUG_ALPHABET.length));
  }
  return `workspace-${suffix}`;
}

export interface SlugFormInput {
  name: string;
  /** What the person typed into the slug field; null until they edit it. */
  typed: string | null;
  /** A random `workspace-…` slug, drawn once per form, for names with no usable Latin. */
  randomFallback: string;
}

export interface SlugFormValue {
  /** What the field shows. */
  slug: string;
  /**
   * Whether the request carries it. A slug derived from the name is left to the server, which adds
   * "-2", "-3"… when it is taken; a typed or random one is sent, so what you see is what you get.
   */
  send: boolean;
}

export function slugForForm({ name, typed, randomFallback }: SlugFormInput): SlugFormValue {
  if (typed !== null) {
    return { slug: typed, send: true };
  }
  if (name.trim() === '') {
    return { slug: '', send: false };
  }
  const fromName = slugFromName(name);
  return fromName === null ? { slug: randomFallback, send: true } : { slug: fromName, send: false };
}
