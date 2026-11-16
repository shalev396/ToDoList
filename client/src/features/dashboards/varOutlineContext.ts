import { createContext, useContext } from 'react';

export interface VarOutlineValue {
  /** Blocks to outline: the ones that listen to the variable a filter is focused or hovered on. */
  outlined: ReadonlySet<string>;
  /** A filter calls this with its variable on focus or hover, and undefined when it leaves. */
  highlight: (ref: string | undefined) => void;
}

export const NO_OUTLINE: VarOutlineValue = { outlined: new Set(), highlight: () => undefined };
export const VarOutlineContext = createContext<VarOutlineValue>(NO_OUTLINE);

export function useVarOutline(): VarOutlineValue {
  return useContext(VarOutlineContext);
}
