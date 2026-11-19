/**
 * From a row a view already holds to the shared colour rule's input (`@api-types/colours`), and
 * from the workspace's topics and attributes to its context. Every view colours through these.
 */
import type { AttributeDef } from '@api-types/attributes.ts';
import { SUBJECT_ATTRIBUTE_KEY } from '@api-types/attributes.ts';
import type { ColourContext, ColourInput, ColourKind } from '@api-types/colours.ts';
import { subjectsOf, UNSORTED_FAMILY } from '@api-types/colours.ts';
import type { TopicColour } from '@api-types/topics.ts';

/** What the rule reads from an item; a block query's `ItemQueryRow` is one. */
export interface ColourRow {
  kind: ColourKind;
  title: string;
  topicId: string | null;
  source: { provider: string };
  props: Record<string, unknown>;
  overlay: { topicOverride: string | null; attrs: Record<string, unknown> };
}

/** The item's own Subject value (overlay attribute) and a time block's layer (`props.layer`). */
export function colourInputOf(row: ColourRow): ColourInput {
  const subject = row.overlay.attrs[SUBJECT_ATTRIBUTE_KEY];
  const layer = row.props['layer'];
  return {
    kind: row.kind,
    provider: row.source.provider,
    title: row.title,
    topicId: row.topicId,
    topicOverride: row.overlay.topicOverride,
    subject: typeof subject === 'string' ? subject : null,
    layer: layer === 'block' || layer === 'area' ? layer : null,
  };
}

/** A topic that has no family yet reads as gray. */
export function colourContextOf(
  topics: readonly { id: string; colour: TopicColour | null }[],
  attributes: readonly AttributeDef[],
): ColourContext {
  return {
    topicFamilies: new Map(topics.map((topic) => [topic.id, topic.colour ?? UNSORTED_FAMILY])),
    subjects: subjectsOf(attributes),
  };
}
