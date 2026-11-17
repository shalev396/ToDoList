/**
 * Custom attributes on the client (H4): helpers shared by the settings form and the item sheet.
 * Pure, so they are tested without the UI.
 */
import type { AttributeDef } from '@api-types/attributes.ts';
import { ATTRIBUTE_KEY_PATTERN } from '@api-types/attributes.ts';

/** `Story size` → `story_size`: a slug the server accepts, or '' when nothing usable is left. */
export function slugKey(name: string): string {
  const slug = name
    .normalize('NFKD')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '_')
    .replace(/^_+|_+$/g, '')
    .slice(0, 32);
  const lettered = /^[a-z]/.test(slug) ? slug : slug === '' ? '' : `a_${slug}`.slice(0, 32);
  return ATTRIBUTE_KEY_PATTERN.test(lettered) ? lettered : '';
}

/** One option per line, trimmed, without blanks or repeats. */
export function parseOptions(text: string): string[] {
  const seen = new Set<string>();
  for (const line of text.split('\n')) {
    const option = line.trim();
    if (option !== '') {
      seen.add(option.slice(0, 40));
    }
  }
  return [...seen].slice(0, 30);
}

/** The value an attribute shows: set values as stored; the built-in Importance reads 3 unset. */
export function shownValue(def: AttributeDef, attrs: Record<string, unknown>): unknown {
  const value = attrs[def.key];
  if (value === undefined || value === null) {
    return def.builtIn && def.key === 'importance' ? 3 : null;
  }
  return value;
}

/** True when the item holds a value for the attribute (the built-in's default is not one). */
export function hasValue(def: AttributeDef, attrs: Record<string, unknown>): boolean {
  const value = attrs[def.key];
  return value !== undefined && value !== null;
}

/** A date attribute's value as the date input shows it. */
export function dateOf(value: unknown): string {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}/.test(value) ? value.slice(0, 10) : '';
}
