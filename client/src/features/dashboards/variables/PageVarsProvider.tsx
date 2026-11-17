import { useCallback, useMemo, type ReactNode } from 'react';
import type { DashboardScope, DashboardVars, VarValue } from '@api-types/builder';
import { PageVarsContext, type PageVarsValue } from './pageVars';
import { routeBindings, type DashboardRoute } from './routeBindings';
import { useUrlVars } from './useUrlVars';
import type { PageVars } from './urlVars';

interface PageVarsProviderProps {
  dashboard: { scope: DashboardScope; vars: DashboardVars };
  route: DashboardRoute;
  children: ReactNode;
}

/**
 * The page variables of one dashboard (FRONTEND.md §4): its default `vars`, overridden by the URL
 * (`?provider=jira`), and the route's bindings on top (a group page's group, a topic's area).
 * Setting a variable writes the URL, so every state can be shared and survives a reload.
 */
export function PageVarsProvider({ dashboard, route, children }: PageVarsProviderProps) {
  const { urlVars, setUrlVar } = useUrlVars();
  const defaults = dashboard.vars;
  const bindings = useMemo(() => routeBindings(dashboard, route), [dashboard, route]);

  const vars = useMemo<PageVars>(() => {
    const merged = Object.create(null) as Record<string, VarValue>;
    for (const source of [defaults, urlVars, bindings]) {
      for (const [name, value] of Object.entries(source)) {
        merged[name] = value;
      }
    }
    return merged;
  }, [defaults, urlVars, bindings]);

  const bound = useMemo(() => new Set(Object.keys(bindings)), [bindings]);

  const defaultOf = useCallback(
    (name: string): VarValue | undefined =>
      Object.hasOwn(defaults, name) ? defaults[name] : undefined,
    [defaults],
  );
  const setVar = useCallback(
    (name: string, value: VarValue) => {
      if (!bound.has(name)) {
        setUrlVar(name, value, defaultOf(name));
      }
    },
    [bound, setUrlVar, defaultOf],
  );
  const clearVar = useCallback(
    (name: string) => {
      if (!bound.has(name)) {
        setUrlVar(name, undefined, defaultOf(name));
      }
    },
    [bound, setUrlVar, defaultOf],
  );

  const value = useMemo<PageVarsValue>(
    () => ({ vars, setVar, clearVar, bound }),
    [vars, setVar, clearVar, bound],
  );
  return <PageVarsContext.Provider value={value}>{children}</PageVarsContext.Provider>;
}
