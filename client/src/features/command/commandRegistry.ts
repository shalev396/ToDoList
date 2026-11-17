import { createContext, useContext, useEffect } from 'react';
import type { AppCommand } from '@/features/command/registry';

export interface CommandRegistryValue {
  /** Every registered command, merged (registry.ts mergeCommandSources). */
  commands: AppCommand[];
  /** Adds or replaces one source's commands; returns the unregister function. */
  register: (sourceId: string, commands: readonly AppCommand[]) => () => void;
}

export const CommandRegistryContext = createContext<CommandRegistryValue | null>(null);

export function useCommandRegistry(): CommandRegistryValue {
  const value = useContext(CommandRegistryContext);
  if (value === null) {
    throw new Error('useCommandRegistry must be used within CommandRegistryProvider');
  }
  return value;
}

/**
 * Offers commands in ⌘K while the calling component is mounted: "Add block" from the dashboard,
 * "Sync now" from integrations, and so on. Pass a memoized array (useMemo), or the commands are
 * registered again on every render.
 */
export function useRegisterCommands(sourceId: string, commands: readonly AppCommand[]): void {
  const { register } = useCommandRegistry();
  useEffect(() => register(sourceId, commands), [register, sourceId, commands]);
}
