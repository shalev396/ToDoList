import { useMemo, useState, type ReactNode } from 'react';
import { listeningBlockIds } from './outline';
import { VarOutlineContext } from './varOutlineContext';

/** Outlines the blocks that listen to a filter's variable while the filter is focused or hovered. */
export function VarOutlineProvider({
  blocks,
  children,
}: {
  blocks: readonly { id: string; listen?: readonly string[] | undefined }[];
  children: ReactNode;
}) {
  const [ref, highlight] = useState<string | undefined>(undefined);
  const value = useMemo(
    () => ({ outlined: listeningBlockIds(blocks, ref), highlight }),
    [blocks, ref],
  );
  return <VarOutlineContext value={value}>{children}</VarOutlineContext>;
}
