import { useCallback, useMemo, useState, type ReactNode } from 'react';
import { CommandRegistryContext } from '@/features/command/commandRegistry';
import { mergeCommandSources, type AppCommand } from '@/features/command/registry';

/** Holds the commands each mounted source registered (useRegisterCommands). */
export function CommandRegistryProvider({ children }: { children: ReactNode }) {
  const [sources, setSources] = useState<ReadonlyMap<string, readonly AppCommand[]>>(new Map());

  const register = useCallback((sourceId: string, commands: readonly AppCommand[]) => {
    setSources((previous) => new Map(previous).set(sourceId, commands));
    return () => {
      setSources((previous) => {
        const next = new Map(previous);
        next.delete(sourceId);
        return next;
      });
    };
  }, []);

  const value = useMemo(
    () => ({ commands: mergeCommandSources(sources.values()), register }),
    [sources, register],
  );

  return (
    <CommandRegistryContext.Provider value={value}>{children}</CommandRegistryContext.Provider>
  );
}
