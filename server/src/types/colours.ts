/**
 * One rule for every item's colour (topic-colours spec, "The rule"): a family (blue, orange, …)
 * from the item's Subject, else its topic, else gray (Unsorted); a role (scheduled, work, travel,
 * area) from what the item is. Pure: imports only types/ modules, shared with the client
 * (`@api-types/colours`).
 */
import type { AttributeDef } from './attributes.js';
import { SUBJECT_ATTRIBUTE_KEY } from './attributes.js';
import type { ItemKind } from './domain.js';
import { matchesGlob } from './glob.js';
import type { TopicColour } from './topics.js';

export type ColourFamily = TopicColour;
export const COLOUR_ROLES = ['scheduled', 'work', 'travel', 'area'] as const;
export type ColourRole = (typeof COLOUR_ROLES)[number];
export const UNSORTED_FAMILY: ColourFamily = 'gray';

/** Auto-assignment cycle (validated, Task 7); gray is never auto-assigned. */
export const FAMILY_ASSIGN_ORDER = [
  'blue',
  'orange',
  'teal',
  'amber',
  'pink',
  'green',
  'violet',
  'red',
] as const;

/** Kinds the resolver knows: today's ItemKind plus the two the time-blocks plan adds. */
export type ColourKind = ItemKind | 'block' | 'travel';
export type ColourLayer = 'block' | 'area';

export interface ColourInput {
  kind: ColourKind;
  provider: string;
  title: string;
  topicId: string | null;
  topicOverride: string | null;
  /** The item's own Subject value. */
  subject: string | null;
  /** Time blocks only. */
  layer: ColourLayer | null;
}

export interface ColourSubject {
  name: string;
  family: ColourFamily;
  patterns: readonly string[];
}

export interface ColourContext {
  topicFamilies: ReadonlyMap<string, ColourFamily>;
  subjects: readonly ColourSubject[];
}

export interface ItemColour {
  family: ColourFamily;
  role: ColourRole;
  from: 'subject' | 'topic' | 'unsorted';
  subject: string | null;
  topicId: string | null;
}

export function roleOf(input: Pick<ColourInput, 'kind' | 'provider' | 'layer'>): ColourRole {
  if (input.kind === 'travel') return 'travel';
  if (input.kind === 'block' && input.layer === 'area') return 'area';
  if (input.kind === 'event' && input.provider !== 'local') return 'scheduled';
  return 'work';
}

/**
 * The item's subject: its own value when it names a subject; otherwise the first subject, in
 * option order, with a pattern matching the title; else null.
 */
export function subjectOf(
  input: Pick<ColourInput, 'subject' | 'title'>,
  subjects: readonly ColourSubject[],
): ColourSubject | null {
  const own = input.subject === null ? undefined : subjects.find((s) => s.name === input.subject);
  if (own !== undefined) return own;
  return (
    subjects.find((subject) => subject.patterns.some((p) => matchesGlob(p, input.title))) ?? null
  );
}

export function resolveColour(input: ColourInput, context: ColourContext): ItemColour {
  const role = roleOf(input);
  // A travel leg takes its anchor's topic family: its title is never read for a subject.
  const subject =
    input.kind === 'travel'
      ? (context.subjects.find((s) => s.name === input.subject) ?? null)
      : subjectOf(input, context.subjects);
  const topicId = input.topicOverride ?? input.topicId;
  if (subject !== null) {
    return { family: subject.family, role, from: 'subject', subject: subject.name, topicId };
  }
  const family = topicId === null ? undefined : context.topicFamilies.get(topicId);
  if (family !== undefined) return { family, role, from: 'topic', subject: null, topicId };
  return { family: UNSORTED_FAMILY, role, from: 'unsorted', subject: null, topicId };
}

/**
 * The family a new topic gets: the first of FAMILY_ASSIGN_ORDER not taken; when all are taken,
 * the least-taken, earliest in the order. Gray and null never count.
 */
export function nextFamily(taken: readonly (ColourFamily | null)[]): ColourFamily {
  const counts = new Map<ColourFamily, number>();
  for (const family of taken) {
    if (family !== null) counts.set(family, (counts.get(family) ?? 0) + 1);
  }
  const first = FAMILY_ASSIGN_ORDER.find((family) => !counts.has(family));
  if (first !== undefined) return first;
  let best: ColourFamily = FAMILY_ASSIGN_ORDER[0];
  for (const family of FAMILY_ASSIGN_ORDER) {
    if ((counts.get(family) ?? 0) < (counts.get(best) ?? 0)) best = family;
  }
  return best;
}

/** The workspace's subjects: the `subject` select's options, in order, that have a look. */
export function subjectsOf(attributes: readonly AttributeDef[]): ColourSubject[] {
  const def = attributes.find((attribute) => attribute.key === SUBJECT_ATTRIBUTE_KEY);
  if (def?.type !== 'select') return [];
  const subjects: ColourSubject[] = [];
  for (const option of def.options ?? []) {
    const look = def.optionLooks?.find((entry) => entry.option === option);
    if (look !== undefined) {
      subjects.push({ name: option, family: look.colour, patterns: look.patterns });
    }
  }
  return subjects;
}
