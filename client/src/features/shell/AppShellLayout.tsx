import { Fragment, Suspense, useCallback, useMemo, useState } from 'react';
import { Outlet, useNavigate } from 'react-router-dom';
import { useSelector } from 'react-redux';
import { useTranslation } from 'react-i18next';
import { TooltipProvider } from '@/components/ui/tooltip';
import { selectWorkspaceGeneration } from '@/store/workspaceSlice';
import { useLanguage } from '@/hooks/useLanguage';
import { CommandRegistryProvider } from '@/features/command/CommandRegistryProvider';
import { CommandPalette } from '@/features/command/CommandPalette';
import { useRegisterCommands } from '@/features/command/commandRegistry';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useWorkspaceReconciler } from '@/features/workspaces/useWorkspaceReconciler';
import { Sidebar } from '@/features/shell/Sidebar';
import { MobileTabBar, MobileTopBar } from '@/features/shell/MobileBars';
import { JoinInviteDialog } from '@/features/shell/JoinInviteDialog';
import { KeyboardShortcutsDialog } from '@/features/shell/KeyboardShortcutsDialog';
import { PageSkeleton } from '@/features/shell/PageSkeleton';
import { ShellUiContext, useShellUi, type ShellUi } from '@/features/shell/shellUi';
import { useCoreCommands } from '@/features/shell/useCoreCommands';
import { useGlobalShortcuts } from '@/features/shell/useGlobalShortcuts';
import { buildNavigation } from '@/features/shell/navigation';
import { AddPageDialog } from '@/features/shell/TopicControls';
import { NewTodoSheet } from '@/features/items/create/NewTodoSheet';
import type { NewItemPreset } from '@/features/items/create/timeBlockDraft';
import { useConsentReturn } from '@/features/items/create/useConsentReturn';

const SIDEBAR_STORAGE_KEY = 'todolist-sidebar-collapsed';

function readCollapsed(): boolean {
  try {
    return localStorage.getItem(SIDEBAR_STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

/** Registers the shell's ⌘K commands and the global keyboard shortcuts. Renders nothing. */
function ShellCommands({ onPalette }: { onPalette: () => void }) {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language } = useLanguage();
  const { workspace, role, topics } = useCurrentWorkspace();
  const { toggleSidebar, openShortcuts } = useShellUi();
  useWorkspaceReconciler();
  useConsentReturn();
  useRegisterCommands('shell', useCoreCommands());

  const goTargets = useMemo(() => {
    if (workspace === null) {
      return new Map<string, string>();
    }
    const navigation = buildNavigation({ language, topics, role, t });
    return new Map(
      [...navigation.primary, ...navigation.secondary].flatMap((entry) =>
        entry.shortcutKey === undefined ? [] : [[entry.shortcutKey, entry.to] as const],
      ),
    );
  }, [workspace, language, topics, role, t]);

  useGlobalShortcuts({
    onPalette,
    onGo: (key) => {
      const target = goTargets.get(key);
      if (target !== undefined) {
        void navigate(target);
      }
    },
    onToggleSidebar: toggleSidebar,
    onHelp: openShortcuts,
  });
  return null;
}

/**
 * The signed-in app (DESIGN.md "App shell"): the sidebar on desktop, a top bar and a bottom tab bar
 * on phones, the ⌘K palette, and the page. The page is keyed on the workspace generation: switching
 * workspaces remounts it, so no sheet, dialog, draft or shown-once link survives a switch.
 */
export default function AppShellLayout() {
  const { t } = useTranslation();
  const generation = useSelector(selectWorkspaceGeneration);
  const [paletteOpen, setPaletteOpen] = useState(false);
  const [joinOpen, setJoinOpen] = useState(false);
  const [addPageOpen, setAddPageOpen] = useState(false);
  const [shortcutsOpen, setShortcutsOpen] = useState(false);
  const [newItemOpen, setNewItemOpen] = useState(false);
  const [newItem, setNewItem] = useState<NewItemPreset>({ kind: 'todo' });
  const [collapsed, setCollapsed] = useState(readCollapsed);

  const toggleSidebar = useCallback(() => {
    setCollapsed((previous) => {
      const next = !previous;
      try {
        localStorage.setItem(SIDEBAR_STORAGE_KEY, next ? '1' : '0');
      } catch {
        /* ignore */
      }
      return next;
    });
  }, []);

  const shellUi = useMemo<ShellUi>(() => {
    const openNewItem = (preset: NewItemPreset) => {
      setNewItem(preset);
      setNewItemOpen(true);
    };
    return {
      openPalette: () => {
        setPaletteOpen(true);
      },
      openJoinDialog: () => {
        setJoinOpen(true);
      },
      openAddPage: () => {
        setAddPageOpen(true);
      },
      openNewTodo: () => {
        openNewItem({ kind: 'todo' });
      },
      openNewTodoIn: (topicId) => {
        openNewItem({ kind: 'todo', topicId });
      },
      openNewItem,
      openShortcuts: () => {
        setShortcutsOpen(true);
      },
      sidebarCollapsed: collapsed,
      toggleSidebar,
    };
  }, [collapsed, toggleSidebar]);

  const togglePalette = useCallback(() => {
    setPaletteOpen((open) => !open);
  }, []);

  return (
    <TooltipProvider>
      <ShellUiContext.Provider value={shellUi}>
        <CommandRegistryProvider>
          <ShellCommands onPalette={togglePalette} />
          <a
            href="#main"
            className="sr-only z-50 rounded-sm bg-foreground px-3 py-2 text-sm text-background focus:not-sr-only focus:fixed focus:start-3 focus:top-3"
          >
            {t('app.shell.skipToContent')}
          </a>
          <div className="flex min-h-svh bg-background">
            <Sidebar className="hidden md:flex" />
            <div className="flex min-w-0 flex-1 flex-col">
              <MobileTopBar className="md:hidden" />
              <main
                id="main"
                tabIndex={-1}
                className="flex-1 pb-[calc(3.5rem+var(--safe-bottom))] outline-none md:pb-0"
              >
                <Suspense fallback={<PageSkeleton />}>
                  <Fragment key={generation}>
                    <Outlet />
                  </Fragment>
                </Suspense>
              </main>
            </div>
            <MobileTabBar className="md:hidden" />
          </div>
          <CommandPalette open={paletteOpen} onOpenChange={setPaletteOpen} />
          <JoinInviteDialog open={joinOpen} onOpenChange={setJoinOpen} />
          <AddPageDialog open={addPageOpen} onOpenChange={setAddPageOpen} />
          <KeyboardShortcutsDialog open={shortcutsOpen} onOpenChange={setShortcutsOpen} />
          <NewTodoSheet
            key={generation}
            open={newItemOpen}
            onOpenChange={setNewItemOpen}
            preset={newItem}
          />
        </CommandRegistryProvider>
      </ShellUiContext.Provider>
    </TooltipProvider>
  );
}
