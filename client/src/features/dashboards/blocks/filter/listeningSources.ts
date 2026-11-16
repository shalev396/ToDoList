import type { Block } from '@api-types/builder.ts';

/**
 * The sources a filter block's options come from (PERMISSIONS-V2 ruling 13): the union of the
 * connectors of the blocks that listen to the variable it sets, so a filter offers only values
 * present in what those blocks read. Undefined (every source the viewer may see) when it sets no
 * variable, nothing listens, or a listening block has no connectors field (it reads everything
 * its viewer may see); a listening block with an empty list adds nothing. Sorted, so the facet
 * query's key is stable. Pure.
 */
export function listeningSources(
  filter: Pick<Block, 'sets'>,
  blocks: readonly Pick<Block, 'listen' | 'connectors'>[],
): string[] | undefined {
  if (filter.sets === undefined) {
    return undefined;
  }
  const listening = blocks.filter((block) => block.listen?.includes(filter.sets ?? '') === true);
  if (listening.length === 0) {
    return undefined;
  }
  const sources = new Set<string>();
  for (const block of listening) {
    if (block.connectors === undefined) {
      return undefined;
    }
    for (const id of block.connectors) {
      sources.add(id);
    }
  }
  return [...sources].sort();
}
