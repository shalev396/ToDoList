import { useState } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CirclePlus, ListPlus, PanelLeftClose, PanelLeftOpen, Plus, Search } from 'lucide-react';
import { cn } from '@/lib/utils';
import { Kbd } from '@/components/ui/kbd';
import { Tooltip, TooltipContent, TooltipTrigger } from '@/components/ui/tooltip';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { WorkspaceSwitcher } from '@/features/shell/WorkspaceSwitcher';
import { AccountMenu } from '@/features/shell/AccountMenu';
import {
  buildNavigation,
  isNavEntryActive,
  navEntryName,
  type NavEntry,
} from '@/features/shell/navigation';
import { isApplePlatform, useShellUi } from '@/features/shell/shellUi';
import { RenameTopicInput, TopicRowMenu } from '@/features/shell/TopicControls';
import { canManageTopics } from '@/features/workspaces/topics';
import { ScrollArea } from '@/components/ui/scroll-area';

const row =
  'flex min-h-11 min-w-0 items-center gap-2.5 rounded-sm px-2 text-[13px] pointer-fine:min-h-9 transition-colors duration-150 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

/** A row in the 56px rail: the icon alone, 44px wide on touch screens. */
const railRow = 'w-11 justify-center px-0 pointer-fine:w-9';

/** In the rail, a row's name moves into a tooltip; it stays the link's accessible name. */
function RailTooltip({
  label,
  collapsed,
  shortcut,
  children,
}: {
  label: string;
  collapsed: boolean;
  /** Keys that trigger the same action, shown in the tooltip (also when the sidebar is open). */
  shortcut?: readonly string[];
  children: React.ReactElement;
}) {
  const { isRTL } = useLanguage();
  if (!collapsed && shortcut === undefined) {
    return children;
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>{children}</TooltipTrigger>
      <TooltipContent side={isRTL ? 'left' : 'right'} className="flex items-center gap-2">
        {collapsed ? <span>{label}</span> : null}
        {shortcut === undefined ? null : (
          <span className="flex gap-1" dir="ltr" aria-hidden="true">
            {shortcut.map((key) => (
              <Kbd key={key} className="border-background/30 bg-background/15 text-background">
                {key}
              </Kbd>
            ))}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  );
}

function NavItem({
  entry,
  collapsed,
  canManage = false,
}: {
  entry: NavEntry;
  collapsed: boolean;
  /** A topic's row: rename and delete it from its "…" menu. */
  canManage?: boolean;
}) {
  const { pathname } = useLocation();
  const [renaming, setRenaming] = useState(false);
  const active = isNavEntryActive(entry, pathname);
  const Icon = entry.icon;
  const { topic } = entry;
  const managed = canManage && !collapsed && topic !== undefined;
  if (managed && renaming) {
    return (
      <li className={cn(row, 'gap-2 bg-sunken px-1.5')}>
        <Icon className="ms-0.5 size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
        <RenameTopicInput
          topic={topic}
          onDone={() => {
            setRenaming(false);
          }}
        />
      </li>
    );
  }
  return (
    <li className={managed ? 'flex min-w-0 items-center gap-0.5' : undefined}>
      <RailTooltip
        label={navEntryName(entry)}
        collapsed={collapsed}
        {...(entry.shortcutKey === undefined
          ? {}
          : { shortcut: ['G', entry.shortcutKey.toUpperCase()] })}
      >
        <Link
          to={entry.to}
          aria-current={active ? 'page' : undefined}
          aria-label={collapsed || entry.trailing !== undefined ? navEntryName(entry) : undefined}
          className={cn(
            row,
            collapsed && railRow,
            managed && 'flex-1',
            active
              ? 'bg-sunken font-medium text-foreground'
              : 'text-muted-foreground hover:bg-sunken hover:text-foreground',
          )}
        >
          <Icon className="size-4 shrink-0" aria-hidden="true" />
          {collapsed ? null : (
            <>
              <span className="min-w-0 flex-1 truncate">{entry.label}</span>
              {entry.trailing === undefined ? null : (
                <span className="shrink-0 text-xs text-muted-foreground">{entry.trailing}</span>
              )}
            </>
          )}
        </Link>
      </RailTooltip>
      {managed ? (
        <TopicRowMenu
          topic={topic}
          onRename={() => {
            setRenaming(true);
          }}
        />
      ) : null}
    </li>
  );
}

/** "New to-do", above the pages: editors and owners. */
function NewTodoRow({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const { openNewTodo } = useShellUi();
  return (
    <RailTooltip label={t('items.newTodo.open')} collapsed={collapsed}>
      <button
        type="button"
        onClick={openNewTodo}
        aria-label={collapsed ? t('items.newTodo.open') : undefined}
        data-new-todo-open=""
        className={cn(
          row,
          'mt-1 font-medium text-foreground hover:bg-sunken',
          collapsed ? railRow : 'w-full',
        )}
      >
        <ListPlus className="size-4 shrink-0" aria-hidden="true" />
        {collapsed ? null : <span className="flex-1 text-start">{t('items.newTodo.open')}</span>}
      </button>
    </RailTooltip>
  );
}

/** "+ Add page", under the topics: editors and owners. */
function AddPageRow({ collapsed }: { collapsed: boolean }) {
  const { t } = useTranslation();
  const { openAddPage } = useShellUi();
  return (
    <li>
      <RailTooltip label={t('topics.addPage')} collapsed={collapsed}>
        <button
          type="button"
          onClick={openAddPage}
          aria-label={collapsed ? t('topics.addPage') : undefined}
          className={cn(
            row,
            'text-muted-foreground hover:bg-sunken hover:text-foreground',
            collapsed ? railRow : 'w-full',
          )}
        >
          <Plus className="size-4 shrink-0" aria-hidden="true" />
          {collapsed ? null : <span className="flex-1 text-start">{t('topics.addPage')}</span>}
        </button>
      </RailTooltip>
    </li>
  );
}

/**
 * The desktop sidebar (DESIGN.md app shell): 240px on the page plane, one hairline at its end,
 * collapsing to a 56px rail. It sits on the end side in RTL by the logical layout alone.
 */
export function Sidebar({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { workspace, role, topics } = useCurrentWorkspace();
  const { openPalette, sidebarCollapsed: collapsed, toggleSidebar } = useShellUi();
  const navigation = workspace === null ? null : buildNavigation({ language, topics, role, t });
  const canManage = canManageTopics(role);
  const searchKeys = isApplePlatform() ? ['⌘', 'K'] : ['Ctrl', 'K'];

  return (
    <nav
      aria-label={t('app.shell.nav')}
      className={cn(
        'sticky top-0 flex h-svh shrink-0 flex-col gap-1 border-e bg-background py-3 transition-[width] duration-150 ease-out motion-reduce:transition-none',
        collapsed ? 'w-14 items-center px-2.5' : 'w-60 px-3',
        className,
      )}
    >
      <WorkspaceSwitcher compact={collapsed} />

      <RailTooltip label={t('app.shell.search')} collapsed={collapsed}>
        <button
          type="button"
          onClick={openPalette}
          aria-label={collapsed ? t('app.shell.search') : undefined}
          aria-keyshortcuts="Meta+K Control+K"
          className={cn(
            row,
            'mt-1 text-muted-foreground hover:bg-sunken hover:text-foreground',
            collapsed ? railRow : 'w-full',
          )}
        >
          <Search className="size-4 shrink-0" aria-hidden="true" />
          {collapsed ? null : (
            <>
              <span className="flex-1 text-start">{t('app.shell.search')}</span>
              <span className="flex gap-0.5" dir="ltr" aria-hidden="true">
                {searchKeys.map((key) => (
                  <Kbd key={key}>{key}</Kbd>
                ))}
              </span>
            </>
          )}
        </button>
      </RailTooltip>

      {canManage ? <NewTodoRow collapsed={collapsed} /> : null}

      <ScrollArea className="min-h-0 w-full flex-1">
        {navigation === null ? (
          <ul className="mt-3 flex w-full flex-col gap-0.5">
            <li>
              <RailTooltip label={t('app.shell.createWorkspace')} collapsed={collapsed}>
                <Link
                  to={pathTo(ROUTES.ONBOARDING, language)}
                  aria-label={collapsed ? t('app.shell.createWorkspace') : undefined}
                  className={cn(row, 'text-foreground hover:bg-sunken', collapsed && railRow)}
                >
                  <CirclePlus className="size-4 shrink-0" aria-hidden="true" />
                  {collapsed ? null : <span>{t('app.shell.createWorkspace')}</span>}
                </Link>
              </RailTooltip>
            </li>
          </ul>
        ) : (
          <>
            <ul className="mt-3 flex w-full flex-col gap-0.5">
              {navigation.primary.map((entry) => (
                <NavItem key={entry.id} entry={entry} collapsed={collapsed} canManage={canManage} />
              ))}
              {canManage ? <AddPageRow collapsed={collapsed} /> : null}
            </ul>
            <hr className="my-2 w-full border-border" />
            <ul className="flex w-full flex-col gap-0.5">
              {navigation.secondary.map((entry) => (
                <NavItem key={entry.id} entry={entry} collapsed={collapsed} />
              ))}
            </ul>
          </>
        )}
      </ScrollArea>

      <div className="mt-auto flex w-full flex-col gap-1">
        <AccountMenu compact={collapsed} />
        <RailTooltip
          label={collapsed ? t('app.shell.expand') : t('app.shell.collapse')}
          collapsed={collapsed}
        >
          <button
            type="button"
            onClick={toggleSidebar}
            aria-label={collapsed ? t('app.shell.expand') : t('app.shell.collapse')}
            aria-keyshortcuts="["
            className={cn(
              row,
              'text-muted-foreground hover:bg-sunken hover:text-foreground',
              collapsed ? railRow : 'w-full',
            )}
          >
            {collapsed ? (
              <PanelLeftOpen className="size-4 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
            ) : (
              <PanelLeftClose className="size-4 shrink-0 rtl:-scale-x-100" aria-hidden="true" />
            )}
            {collapsed ? null : (
              <span className="flex-1 text-start">{t('app.shell.collapse')}</span>
            )}
          </button>
        </RailTooltip>
      </div>
    </nav>
  );
}
