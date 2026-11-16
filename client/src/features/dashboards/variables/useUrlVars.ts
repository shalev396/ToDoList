import { useCallback, useMemo } from 'react';
import { useSearchParams } from 'react-router-dom';
import type { VarValue } from '@api-types/builder';
import { readUrlVars, withUrlVar, type PageVars } from './urlVars';

/**
 * The page variables in the URL, and a setter that keeps every other param (`edit`, `item`). A
 * change replaces the history entry: stepping through filters with Back would be churn.
 */
export function useUrlVars(): {
  urlVars: PageVars;
  setUrlVar: (
    name: string,
    value: VarValue | undefined,
    defaultValue: VarValue | undefined,
  ) => void;
} {
  const [searchParams, setSearchParams] = useSearchParams();
  const urlVars = useMemo(() => readUrlVars(searchParams), [searchParams]);
  const setUrlVar = useCallback(
    (name: string, value: VarValue | undefined, defaultValue: VarValue | undefined) => {
      setSearchParams((current) => withUrlVar(current, name, value, defaultValue), {
        replace: true,
      });
    },
    [setSearchParams],
  );
  return { urlVars, setUrlVar };
}
