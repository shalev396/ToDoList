/**
 * The Subjects section's draft: the `subject` select's options in order, each with its colour
 * family and title patterns, edited as a whole and saved with one request.
 */
import { nextFamily } from '@api-types/colours.ts';
import {
  MAX_ATTRIBUTE_OPTIONS,
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
