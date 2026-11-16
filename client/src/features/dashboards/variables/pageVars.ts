import { createContext, useContext } from 'react';
import type { VarValue } from '@api-types/builder';
import type { PageVars } from './urlVars';

export interface PageVarsValue {
  /** Every page variable by bare name: the dashboard's defaults, then the URL, then the route. */
  vars: PageVars;
  /** Sets a variable in the URL, replacing the history entry (filters change often). */
  setVar: (name: string, value: VarValue) => void;
  /** Back to the dashboard's default (the param leaves the URL). */
  clearVar: (name: string) => void;
  /** Variables the route fixes (a group page's group); setting one does nothing. */
  bound: ReadonlySet<string>;
}

const NONE: PageVarsValue = {
  vars: Object.freeze(Object.create(null) as Record<string, VarValue>),
  setVar: () => undefined,
  clearVar: () => undefined,
  bound: new Set(),
};

export const PageVarsContext = createContext<PageVarsValue>(NONE);

/** The page's variables and their setters (empty outside a dashboard). */
export function usePageVars(): PageVarsValue {
  return useContext(PageVarsContext);
}
