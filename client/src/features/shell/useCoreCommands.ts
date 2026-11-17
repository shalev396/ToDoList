import { useMemo } from 'react';
import { useNavigate } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import {
  Building2,
  CirclePlus,
  FilePlus2,
  Keyboard,
  Languages,
  Link2,
  ListPlus,
  LogOut,
  Moon,
  PanelLeft,
  Sun,
  UserRound,
  Users,
} from 'lucide-react';
import { useTheme } from '@/components/theme-context';
import { useLanguage } from '@/hooks/useLanguage';
import { LANGUAGE_NAMES } from '@/i18n/config';
import { pathTo, ROUTES } from '@/router/routes';
import type { AppCommand } from '@/features/command/registry';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useSwitchWorkspace } from '@/features/workspaces/useSwitchWorkspace';
import { buildNavigation } from '@/features/shell/navigation';
import { canManageTopics } from '@/features/workspaces/topics';
import { useShellUi } from '@/features/shell/shellUi';
import { useSignOut } from '@/features/shell/useSignOut';

/** Splits a translated keyword string ("log out logout exit") into search terms. */
function words(text: string): string[] {
  return text.split(/\s+/).filter(Boolean);
}

/**
 * The shell's ⌘K commands: every page and topic, switching and creating workspaces, theme,
 * language, the sidebar and signing out. Pages add their own with useRegisterCommands.
 */
export function useCoreCommands(): AppCommand[] {
  const { t } = useTranslation();
  const navigate = useNavigate();
  const { language, changeLanguage, availableLanguages } = useLanguage();
  const { theme, setTheme } = useTheme();
  const { workspace, workspaces, role, topics } = useCurrentWorkspace();
  const switchWorkspace = useSwitchWorkspace();
  const { openJoinDialog, openAddPage, openNewTodo, openShortcuts, toggleSidebar } = useShellUi();
  const signOut = useSignOut();

  return useMemo(() => {
    const go = (to: string) => () => {
      void navigate(to);
    };
    const navigation = workspace === null ? null : buildNavigation({ language, topics, role, t });
    const pages: AppCommand[] =
      navigation === null
        ? []
        : [...navigation.primary, ...navigation.secondary].map((entry) => ({
            id: `go-${entry.id}`,
            group: 'navigation',
            label: entry.label,
            icon: entry.icon,
            keywords: words(
              t(
                entry.id.startsWith('topic-')
                  ? 'commandPalette.keywords.topic'
                  : `commandPalette.keywords.${entry.id}`,
              ),
            ),
            ...(entry.shortcutKey === undefined
              ? {}
              : { shortcut: ['G', entry.shortcutKey.toUpperCase()] }),
            run: go(entry.to),
          }));
    if (workspace !== null && canManageTopics(role)) {
      pages.push({
        id: 'add-page',
        group: 'navigation',
        label: t('topics.addPage'),
        icon: FilePlus2,
        keywords: words(t('commandPalette.keywords.addPage')),
        run: openAddPage,
      });
    }
    if (workspace !== null) {
      pages.push({
        id: 'go-members',
        group: 'navigation',
        label: t('commandPalette.commands.members'),
        icon: Users,
        keywords: words(t('commandPalette.keywords.members')),
        run: go(pathTo(ROUTES.MEMBERS, language)),
      });
    }
    pages.push({
      id: 'go-profile',
      group: 'navigation',
      label: t('commandPalette.commands.profile'),
      icon: UserRound,
      keywords: words(t('commandPalette.keywords.profile')),
      run: go(pathTo(ROUTES.PROFILE, language)),
    });

    const actions: AppCommand[] =
      workspace !== null && canManageTopics(role)
        ? [
            {
              id: 'new-todo',
              group: 'actions',
              label: t('commandPalette.commands.newTodo'),
              icon: ListPlus,
              keywords: words(t('commandPalette.keywords.newTodo')),
              run: openNewTodo,
            },
          ]
        : [];

    const workspaceCommands: AppCommand[] = [
      ...workspaces
        .filter((entry) => entry.workspace.id !== workspace?.id)
        .map(
          (entry): AppCommand => ({
            id: `workspace-${entry.workspace.id}`,
            group: 'workspaces',
            label: t('commandPalette.commands.switchWorkspace', {
              workspace: entry.workspace.name,
            }),
            icon: Building2,
            keywords: words(t('commandPalette.keywords.workspace')),
            run: () => {
              switchWorkspace(entry.workspace.id);
            },
          }),
        ),
      {
        id: 'workspace-create',
        group: 'workspaces',
        label: t('commandPalette.commands.createWorkspace'),
        icon: CirclePlus,
        keywords: words(t('commandPalette.keywords.workspace')),
        run: go(pathTo(ROUTES.ONBOARDING, language)),
      },
      {
        id: 'workspace-join',
        group: 'workspaces',
        label: t('commandPalette.commands.joinWorkspace'),
        icon: Link2,
        keywords: words(t('commandPalette.keywords.workspace')),
        run: openJoinDialog,
      },
    ];

    const preferences: AppCommand[] = [
      theme === 'dark'
        ? {
            id: 'theme',
            group: 'preferences',
            label: t('commandPalette.commands.themeLight'),
            icon: Sun,
            keywords: words(t('commandPalette.keywords.theme')),
            run: () => {
              setTheme('light');
            },
          }
        : {
            id: 'theme',
            group: 'preferences',
            label: t('commandPalette.commands.themeDark'),
            icon: Moon,
            keywords: words(t('commandPalette.keywords.theme')),
            run: () => {
              setTheme('dark');
            },
          },
      ...availableLanguages
        .filter((lng) => lng !== language)
        .map(
          (lng): AppCommand => ({
            id: `language-${lng}`,
            group: 'preferences',
            label: t('commandPalette.commands.language', { language: LANGUAGE_NAMES[lng] }),
            icon: Languages,
            keywords: words(t('commandPalette.keywords.language')),
            run: () => {
              changeLanguage(lng);
            },
          }),
        ),
      {
        id: 'sidebar',
        group: 'preferences',
        label: t('commandPalette.commands.toggleSidebar'),
        icon: PanelLeft,
        keywords: words(t('commandPalette.keywords.sidebar')),
        shortcut: ['['],
        run: toggleSidebar,
      },
      {
        id: 'shortcuts',
        group: 'preferences',
        label: t('shortcuts.title'),
        icon: Keyboard,
        keywords: words(t('commandPalette.keywords.shortcuts')),
        shortcut: ['?'],
        run: openShortcuts,
      },
    ];

    const account: AppCommand[] = [
      {
        id: 'sign-out',
        group: 'account',
        label: t('commandPalette.commands.signOut'),
        icon: LogOut,
        keywords: words(t('commandPalette.keywords.signOut')),
        run: signOut,
      },
    ];

    return [...actions, ...pages, ...workspaceCommands, ...preferences, ...account];
  }, [
    t,
    navigate,
    language,
    changeLanguage,
    availableLanguages,
    theme,
    setTheme,
    workspace,
    workspaces,
    role,
    topics,
    switchWorkspace,
    openJoinDialog,
    openAddPage,
    openNewTodo,
    openShortcuts,
    toggleSidebar,
    signOut,
  ]);
}
