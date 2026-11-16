/**
 * The ⌘K command registry. Commands come from several sources (the shell's navigation and account
 * commands now; later "Add block", "Sync now", "Quick add to-do" from the pages that own them),
 * registered through CommandRegistryProvider. Filtering and grouping are pure, so the palette is a
 * thin view over them.
 */
import type { LucideIcon } from 'lucide-react';

export type CommandGroupId = 'actions' | 'navigation' | 'workspaces' | 'preferences' | 'account';

/** Display order of the groups, whatever the query. */
export const COMMAND_GROUP_ORDER: readonly CommandGroupId[] = [
  'actions',
  'navigation',
  'workspaces',
  'preferences',
  'account',
];

export interface AppCommand {
  /** Unique across sources; a later registration with the same id replaces the earlier one. */
  id: string;
  group: CommandGroupId;
  /** Already translated. */
  label: string;
  /** Other words people may type for it, in any language. */
  keywords?: readonly string[] | undefined;
  icon?: LucideIcon | undefined;
  /** Keys shown at the end of the row, e.g. ['G', 'D']. */
  shortcut?: readonly string[] | undefined;
  /** Registered but not offered right now (e.g. a page action outside its page). */
  hidden?: boolean | undefined;
  run: () => void;
}

/** Lowercase, accents and Hebrew points removed, single spaces. */
export function normalizeForSearch(text: string): string {
  return text.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().replace(/\s+/g, ' ').trim();
}

function wordStarts(field: string, token: string): boolean {
  return field.split(' ').some((word) => word.startsWith(token));
}

/** How well one token matches: label beats keywords, a word start beats the middle of a word. */
function tokenScore(token: string, label: string, keywords: readonly string[]): number {
  if (label.startsWith(token)) {
    return 4;
  }
  if (wordStarts(label, token)) {
    return 3;
  }
  if (label.includes(token)) {
    return 2;
  }
  if (keywords.some((keyword) => wordStarts(keyword, token))) {
    return 1.5;
  }
  if (keywords.some((keyword) => keyword.includes(token))) {
    return 1;
  }
  return 0;
}

/** Null when some token of the query matches nowhere. */
function scoreCommand(command: AppCommand, tokens: readonly string[]): number | null {
  const label = normalizeForSearch(command.label);
  const keywords = (command.keywords ?? []).map(normalizeForSearch);
  let total = 0;
  for (const token of tokens) {
    const score = tokenScore(token, label, keywords);
    if (score === 0) {
      return null;
    }
    total += score;
  }
  return total;
}

/**
 * The commands that match every word of the query, in group order; within a group the best
 * matches come first, ties keep registration order. An empty query offers everything.
 */
export function filterCommands(commands: readonly AppCommand[], query: string): AppCommand[] {
  const tokens = normalizeForSearch(query).split(' ').filter(Boolean);
  const scored = commands.flatMap((command, index) => {
    if (command.hidden === true) {
      return [];
    }
    const score = tokens.length === 0 ? 0 : scoreCommand(command, tokens);
    return score === null ? [] : [{ command, index, score }];
  });
  const groupRank = (group: CommandGroupId) => COMMAND_GROUP_ORDER.indexOf(group);
  scored.sort(
    (a, b) =>
      groupRank(a.command.group) - groupRank(b.command.group) ||
      b.score - a.score ||
      a.index - b.index,
  );
  return scored.map((entry) => entry.command);
}

export interface CommandGroup {
  group: CommandGroupId;
  commands: AppCommand[];
}

/** Consecutive runs of one group, in display order; groups without commands are left out. */
export function groupCommands(commands: readonly AppCommand[]): CommandGroup[] {
  return COMMAND_GROUP_ORDER.flatMap((group) => {
    const inGroup = commands.filter((command) => command.group === group);
    return inGroup.length === 0 ? [] : [{ group, commands: inGroup }];
  });
}

/** All sources as one list. A repeated id keeps its first position and the latest command. */
export function mergeCommandSources(sources: Iterable<readonly AppCommand[]>): AppCommand[] {
  const byId = new Map<string, AppCommand>();
  for (const source of sources) {
    for (const command of source) {
      byId.set(command.id, command);
    }
  }
  return [...byId.values()];
}
