/**
 * The Subjects section's draft: the `subject` select's options in order, each with its colour
 * family and title patterns, edited as a whole and saved with one request.
 */
import { nextFamily } from '@api-types/colours.ts';
import { GLOB_WILDCARDS_MAX, hasTooManyWildcards } from '@api-types/glob.ts';
import {
  MAX_ATTRIBUTE_OPTIONS,
  OPTION_PATTERN_LENGTH_MAX,
  OPTION_PATTERNS_MAX,
  SUBJECT_ATTRIBUTE_KEY,
  type AttributeDef,
  type AttributePatch,
  type NewAttribute,
  type OptionLook,
} from '@api-types/attributes.ts';
import type { TopicColour } from '@api-types/topics.ts';

export interface SubjectDraft {
  /** Stable while editing, even when the subject is renamed or moved. */
  key: string;
  name: string;
  /** The saved option this row started as; null for a row added in this draft. */
  savedName: string | null;
  family: TopicColour;
  patterns: string[];
}

export type SubjectRequest = { create: NewAttribute } | { patch: AttributePatch };

/** The draft of a saved `subject` attribute (none: no rows). A subject without a look is filled. */
export function draftOf(def: AttributeDef | undefined): SubjectDraft[] {
  const draft: SubjectDraft[] = [];
  for (const [index, option] of (def?.options ?? []).entries()) {
    const look = def?.optionLooks?.find((entry) => entry.option === option);
    draft.push({
      key: `saved-${String(index)}`,
      name: option,
      savedName: option,
      family: look?.colour ?? nextFamily(draft.map((subject) => subject.family)),
      patterns: look?.patterns ?? [],
    });
  }
  return draft;
}

/**
 * The subject names to offer (the time block form's Subject), in this section's order: the options
 * of the workspace's `subject` select; none while it doesn't exist (the first block adds it).
 */
export function subjectOptions(attributes: readonly AttributeDef[] | undefined): string[] {
  const def = attributes?.find((attribute) => attribute.key === SUBJECT_ATTRIBUTE_KEY);
  return def?.type === 'select' ? [...(def.options ?? [])] : [];
}

/** One pattern per line or per comma, trimmed, empty ones dropped. */
export function parsePatterns(text: string): string[] {
  return text
    .split(/[\n,]/)
    .map((pattern) => pattern.trim())
    .filter((pattern) => pattern !== '');
}

function freshKey(draft: readonly SubjectDraft[]): string {
  let n = draft.length;
  while (draft.some((subject) => subject.key === `new-${String(n)}`)) {
    n += 1;
  }
  return `new-${String(n)}`;
}

/**
 * A new row at the end, in the next family the topics and the other subjects leave free (what the
 * server would pick). An empty, repeated or one-too-many name changes nothing.
 */
export function addSubject(
  draft: SubjectDraft[],
  name: string,
  topicFamilies: readonly (TopicColour | null)[],
): SubjectDraft[] {
  const trimmed = name.trim();
  if (
    trimmed === '' ||
    draft.length >= MAX_ATTRIBUTE_OPTIONS ||
    draft.some((subject) => subject.name === trimmed)
  ) {
    return draft;
  }
  const family = nextFamily([...topicFamilies, ...draft.map((subject) => subject.family)]);
  return [...draft, { key: freshKey(draft), name: trimmed, savedName: null, family, patterns: [] }];
}

/**
 * The rows after an edit, built over what is saved (or what he has already edited). Before the
 * saved subjects are read there is nothing to build on: the edit is refused (null), because a
 * draft started from the empty list would replace the saved subjects when it is saved.
 */
export function editedRows(
  loaded: boolean,
  saved: AttributeDef | undefined,
  edited: SubjectDraft[] | null,
  change: (rows: SubjectDraft[]) => SubjectDraft[],
): SubjectDraft[] | null {
  return loaded ? change(edited ?? draftOf(saved)) : null;
}

/** One place up (-1) or down (1); the same draft at an edge. */
export function moveSubject(draft: SubjectDraft[], key: string, by: -1 | 1): SubjectDraft[] {
  const from = draft.findIndex((subject) => subject.key === key);
  const to = from + by;
  const row = draft[from];
  const other = draft[to];
  if (row === undefined || other === undefined) {
    return draft;
  }
  const next = [...draft];
  next[from] = other;
  next[to] = row;
  return next;
}

function sameLooks(a: readonly OptionLook[], b: readonly OptionLook[]): boolean {
  return (
    a.length === b.length &&
    a.every((look, index) => {
      const other = b[index];
      if (other === undefined) {
        return false;
      }
      return (
        look.option === other.option &&
        look.colour === other.colour &&
        look.patterns.length === other.patterns.length &&
        look.patterns.every((pattern, at) => pattern === other.patterns[at])
      );
    })
  );
}

/**
 * What saving needs: the attribute created, or its options and looks patched (with the renames, so
 * stored values follow). Null when nothing changed or there is nothing to save.
 */
export function requestOf(
  saved: AttributeDef | undefined,
  draft: readonly SubjectDraft[],
  attributeName: string,
): SubjectRequest | null {
  if (draft.length === 0) {
    return null;
  }
  const options = draft.map((subject) => subject.name.trim());
  const optionLooks: OptionLook[] = draft.map((subject, index) => ({
    option: options[index] ?? subject.name,
    colour: subject.family,
    patterns: subject.patterns,
  }));
  if (saved === undefined) {
    return {
      create: {
        key: SUBJECT_ATTRIBUTE_KEY,
        name: attributeName,
        type: 'select',
        options,
        optionLooks,
      },
    };
  }
  const renames = draft.flatMap((subject, index) => {
    const to = options[index] ?? subject.name;
    return subject.savedName !== null && subject.savedName !== to
      ? [{ from: subject.savedName, to }]
      : [];
  });
  const sameOptions =
    options.length === (saved.options ?? []).length &&
    options.every((option, index) => option === saved.options?.[index]);
  if (sameOptions && sameLooks(optionLooks, saved.optionLooks ?? []) && renames.length === 0) {
    return null;
  }
  return { patch: { options, optionLooks, ...(renames.length === 0 ? {} : { renames }) } };
}

export type RowIssue =
  | { field: 'name'; code: 'empty' | 'duplicate' }
  | { field: 'patterns'; code: 'count' }
  | { field: 'patterns'; code: 'length' | 'wildcards'; pattern: string };

/** What the server would refuse, per row (by key), found before saving; rows without issues are absent. */
export function issuesOf(draft: readonly SubjectDraft[]): Map<string, RowIssue[]> {
  const issues = new Map<string, RowIssue[]>();
  const seen = new Set<string>();
  for (const subject of draft) {
    const found: RowIssue[] = [];
    const name = subject.name.trim();
    if (name === '') {
      found.push({ field: 'name', code: 'empty' });
    } else if (seen.has(name)) {
      found.push({ field: 'name', code: 'duplicate' });
    }
    seen.add(name);
    if (subject.patterns.length > OPTION_PATTERNS_MAX) {
      found.push({ field: 'patterns', code: 'count' });
    }
    for (const pattern of subject.patterns) {
      if (pattern.length > OPTION_PATTERN_LENGTH_MAX) {
        found.push({ field: 'patterns', code: 'length', pattern });
      } else if (hasTooManyWildcards(pattern)) {
        found.push({ field: 'patterns', code: 'wildcards', pattern });
      }
    }
    if (found.length > 0) {
      issues.set(subject.key, found);
    }
  }
  return issues;
}

export const SUBJECT_LIMITS = {
  subjects: MAX_ATTRIBUTE_OPTIONS,
  patterns: OPTION_PATTERNS_MAX,
  patternLength: OPTION_PATTERN_LENGTH_MAX,
  wildcards: GLOB_WILDCARDS_MAX,
} as const;

/** The server's counts (in the order the subjects were sent) by subject name. */
export function countsByName(
  subjects: readonly { name: string }[],
  counts: readonly number[],
): Record<string, number> {
  const byName: Record<string, number> = {};
  subjects.forEach((subject, index) => {
    const count = counts[index];
    if (count !== undefined) {
      byName[subject.name] = count;
    }
  });
  return byName;
}
