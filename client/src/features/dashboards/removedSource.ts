/**
 * What a block says about its sources (PERMISSIONS-V2), computed from the dashboard on every
 * render, never stored:
 * - `removed`: "A source was removed": one of its connectors is an integration that is gone
 *   (disconnected, or its member left; ruling 6), or Stop sharing took one off it
 *   (`sourceRemoved`). Until the block is edited.
 * - `none`: "No source": it reads data but names no connector (`[]`), so it reads nothing.
 * - null: nothing to say (all sources each viewer may see, or connectors that all still work).
 * Pure.
 */
export type SourceState = 'removed' | 'none' | null;

/** Whether a block names a connector the dashboard reports as removed. */
export function hasRemovedSource(
  block: { connectors?: readonly string[] | undefined },
  connectors: Readonly<Record<string, { removed: boolean }>>,
): boolean {
  return (block.connectors ?? []).some((id) => connectors[id]?.removed === true);
}

export function sourceState(
  block: {
    connectors?: readonly string[] | undefined;
    sourceRemoved?: true | undefined;
    query?: unknown;
    savedViewId?: string | null | undefined;
  },
  connectors: Readonly<Record<string, { removed: boolean }>>,
): SourceState {
  if (block.sourceRemoved === true || hasRemovedSource(block, connectors)) {
    return 'removed';
  }
  const readsData = block.query !== undefined || typeof block.savedViewId === 'string';
  return readsData && block.connectors?.length === 0 ? 'none' : null;
}
