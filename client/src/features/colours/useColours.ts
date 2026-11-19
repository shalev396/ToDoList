import { useCallback, useMemo } from 'react';
import { useAttributes } from '@/api/queries/attributes';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { resolveColour, UNSORTED_FAMILY } from '@api-types/colours';
import type { ColourContext, ColourFamily, ItemColour } from '@api-types/colours';
import type { AttributeDef } from '@api-types/attributes';
import { colourContextOf, colourInputOf, type ColourRow } from './rowColour';

const NO_ATTRIBUTES: AttributeDef[] = [];

/** What not knowing an item paints: Unsorted's gray, in the Work step. */
const UNKNOWN: ItemColour = {
  family: UNSORTED_FAMILY,
  role: 'work',
  from: 'unsorted',
  subject: null,
  topicId: null,
};

/** The current workspace's topic families and subjects. */
export function useColourContext(): ColourContext {
  const { workspace, topics } = useCurrentWorkspace();
  const { data: attributes } = useAttributes(workspace?.id ?? null);
  return useMemo(() => colourContextOf(topics, attributes ?? NO_ATTRIBUTES), [topics, attributes]);
}

/**
 * Each row's colour, by id, through the shared rule. Worked out again when `rows` changes, so pass
 * the query's own array (or a memoized one), not a new array each render.
 */
export function useRowColours(
  rows: readonly (ColourRow & { id: string })[],
): (rowId: string) => ItemColour {
  const context = useColourContext();
  return useMemo(() => {
    const colours = new Map(
      rows.map((row) => [row.id, resolveColour(colourInputOf(row), context)]),
    );
    return (rowId: string) => colours.get(rowId) ?? UNKNOWN;
  }, [rows, context]);
}

/** A topic's family, for totals grouped by topic (charts); null (Unsorted) is gray. */
export function useTopicFamily(): (topicId: string | null) => ColourFamily {
  const { topicFamilies } = useColourContext();
  return useCallback(
    (topicId: string | null) =>
      (topicId === null ? undefined : topicFamilies.get(topicId)) ?? UNSORTED_FAMILY,
    [topicFamilies],
  );
}
