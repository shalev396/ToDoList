import { createContext, useContext } from 'react';
import type { NewItemPreset } from '@/features/items/create/timeBlockDraft';

/** UI state the shell shares with what it renders: the palette, the dialogs, the rail. */
export interface ShellUi {
  openPalette: () => void;
  openJoinDialog: () => void;
  /** "+ Add page" (editors and owners). */
  openAddPage: () => void;
  /** "New to-do" (editors and owners): the sheet with "Also create in". */
  openNewTodo: () => void;
  /** "+ Add" in a List view or list block: the same sheet, on this page (a topic id). */
  openNewTodoIn: (topicId: string) => void;
  /** The same sheet on a kind (a to-do, a time block or an area), a page and times. */
  openNewItem: (preset: NewItemPreset) => void;
  openShortcuts: () => void;
  sidebarCollapsed: boolean;
  toggleSidebar: () => void;
}

export const ShellUiContext = createContext<ShellUi | null>(null);

export function useShellUi(): ShellUi {
  const value = useContext(ShellUiContext);
  if (value === null) {
    throw new Error('useShellUi must be used within AppShellLayout');
  }
  return value;
}

/** "⌘K" on Apple devices, "Ctrl K" elsewhere. */
export function isApplePlatform(): boolean {
  return typeof navigator !== 'undefined' && /Mac|iPhone|iPad|iPod/.test(navigator.userAgent);
}
