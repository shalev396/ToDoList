/** The ids of the blocks that listen to a page variable (`$page.topic`); none without a variable. */
export function listeningBlockIds(
  blocks: readonly { id: string; listen?: readonly string[] | undefined }[],
  ref: string | undefined,
): ReadonlySet<string> {
  const ids = new Set<string>();
  if (ref === undefined) {
    return ids;
  }
  for (const block of blocks) {
    if (block.listen?.includes(ref) === true) {
      ids.add(block.id);
    }
  }
  return ids;
}
