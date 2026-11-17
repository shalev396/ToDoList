import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CirclePlus, Ellipsis, LogOut, Search, UserRound, Users } from 'lucide-react';
import { cn } from '@/lib/utils';
import {
  Sheet,
  SheetClose,
  SheetContent,
  SheetHeader,
  SheetTitle,
  SheetTrigger,
} from '@/components/ui/sheet';
import { useTheme } from '@/components/theme-context';
import { useLanguage } from '@/hooks/useLanguage';
import { LANGUAGE_NAMES } from '@/i18n/config';
import { pathTo, ROUTES } from '@/router/routes';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { WorkspaceSwitcher } from '@/features/shell/WorkspaceSwitcher';
import {
  buildNavigation,
  isNavEntryActive,
  navEntryName,
  type NavEntry,
} from '@/features/shell/navigation';
import { useShellUi } from '@/features/shell/shellUi';
import { useSignOut } from '@/features/shell/useSignOut';
import { ScrollArea } from '@/components/ui/scroll-area';

/** Phones: the workspace switcher and search, above the page. */
export function MobileTopBar({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { openPalette } = useShellUi();
  return (
    <header
      className={cn(
        'sticky top-0 z-30 flex h-12 items-center gap-2 border-b bg-background/90 px-2 pt-[env(safe-area-inset-top)] backdrop-blur-md supports-[backdrop-filter]:bg-background/75',
        className,
      )}
    >
      <div className="min-w-0 max-w-[70%]">
        <WorkspaceSwitcher />
      </div>
      <button
        type="button"
        onClick={openPalette}
        aria-label={t('app.shell.search')}
        className="ms-auto flex size-11 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-sunken hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
      >
        <Search className="size-5" aria-hidden="true" />
      </button>
    </header>
  );
}

const tab =
  'flex min-w-0 flex-1 flex-col items-center justify-center gap-0.5 px-1 text-xs leading-tight transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none focus-visible:ring-inset';

const sheetRow =
  'flex h-11 w-full items-center gap-3 rounded-sm px-2 text-base text-foreground transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none';

const segment =
  'flex min-h-11 flex-1 items-center justify-center rounded-sm text-sm text-muted-foreground pointer-fine:min-h-9 transition-colors duration-150 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none aria-pressed:bg-card aria-pressed:font-medium aria-pressed:text-foreground';

function MoreSheet({ entries }: { entries: NavEntry[] }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { language, changeLanguage, availableLanguages } = useLanguage();
  const { theme, setTheme } = useTheme();
  const { workspace } = useCurrentWorkspace();
  const signOut = useSignOut();
  const active = entries.some((entry) => isNavEntryActive(entry, pathname));

  return (
    <Sheet>
      <SheetTrigger
        className={cn(
          tab,
          active ? 'font-medium text-foreground' : 'text-muted-foreground hover:text-foreground',
        )}
      >
        <Ellipsis className="size-5" aria-hidden="true" />
        <span>{t('app.shell.more')}</span>
      </SheetTrigger>
      <SheetContent side="bottom" closeLabel={t('app.page.close')} aria-describedby={undefined}>
        <SheetHeader className="h-12 justify-center border-b py-0">
          <SheetTitle className="text-sm">{t('app.shell.more')}</SheetTitle>
        </SheetHeader>
        <ScrollArea className="max-h-[70svh]" viewportClassName="max-h-[inherit]">
          <div className="flex flex-col gap-5 px-3 pb-[calc(1.25rem+env(safe-area-inset-bottom))]">
            <ul className="flex flex-col">
              {entries.map((entry) => {
                const Icon = entry.icon;
                return (
                  <li key={entry.id}>
                    <SheetClose asChild>
                      <Link
                        to={entry.to}
                        aria-current={isNavEntryActive(entry, pathname) ? 'page' : undefined}
                        aria-label={entry.trailing === undefined ? undefined : navEntryName(entry)}
                        className={sheetRow}
                      >
                        <Icon className="size-5 text-muted-foreground" aria-hidden="true" />
                        <span className="flex-1">{entry.label}</span>
                        {entry.trailing === undefined ? null : (
                          <span className="text-sm text-muted-foreground">{entry.trailing}</span>
                        )}
                      </Link>
                    </SheetClose>
                  </li>
                );
              })}
              {workspace === null ? (
                <li>
                  <SheetClose asChild>
                    <Link to={pathTo(ROUTES.ONBOARDING, language)} className={sheetRow}>
                      <CirclePlus className="size-5 text-muted-foreground" aria-hidden="true" />
                      <span className="flex-1">{t('app.shell.createWorkspace')}</span>
                    </Link>
                  </SheetClose>
                </li>
              ) : (
                <li>
                  <SheetClose asChild>
                    <Link to={pathTo(ROUTES.MEMBERS, language)} className={sheetRow}>
                      <Users className="size-5 text-muted-foreground" aria-hidden="true" />
                      <span className="flex-1">{t('commandPalette.commands.members')}</span>
                    </Link>
                  </SheetClose>
                </li>
              )}
              <li>
                <SheetClose asChild>
                  <Link to={pathTo(ROUTES.PROFILE, language)} className={sheetRow}>
                    <UserRound className="size-5 text-muted-foreground" aria-hidden="true" />
                    <span className="flex-1">{t('app.userMenu.profile')}</span>
                  </Link>
                </SheetClose>
              </li>
            </ul>

            <div className="flex flex-col gap-3 border-t pt-4">
              <div
                role="group"
                aria-label={t('app.userMenu.language')}
                className="flex gap-1 rounded-md bg-sunken p-1"
              >
                {availableLanguages.map((lng) => (
                  <button
                    key={lng}
                    type="button"
                    lang={lng}
                    aria-pressed={language === lng}
                    className={segment}
                    onClick={() => {
                      changeLanguage(lng);
                    }}
                  >
                    {LANGUAGE_NAMES[lng]}
                  </button>
                ))}
              </div>
              <div
                role="group"
                aria-label={t('app.userMenu.theme')}
                className="flex gap-1 rounded-md bg-sunken p-1"
              >
                {(['light', 'dark'] as const).map((option) => (
                  <button
                    key={option}
                    type="button"
                    aria-pressed={theme === option}
                    className={segment}
                    onClick={() => {
                      setTheme(option);
                    }}
                  >
                    {t(`theme.${option}`)}
                  </button>
                ))}
              </div>
            </div>

            <SheetClose asChild>
              <button type="button" onClick={signOut} className={cn(sheetRow, 'border-t pt-1')}>
                <LogOut className="size-5 text-muted-foreground" aria-hidden="true" />
                <span className="flex-1 text-start">{t('app.userMenu.signOut')}</span>
              </button>
            </SheetClose>
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}

/** Phones: Dashboard, up to three topics, and More (DESIGN.md, FRONTEND.md §12). */
export function MobileTabBar({ className }: { className?: string }) {
  const { t } = useTranslation();
  const { pathname } = useLocation();
  const { language } = useLanguage();
  const { workspace, role, topics } = useCurrentWorkspace();
  const navigation = workspace === null ? null : buildNavigation({ language, topics, role, t });
  const tabs = navigation?.primary.slice(0, 4) ?? [];
  const more = [...(navigation?.primary.slice(4) ?? []), ...(navigation?.secondary ?? [])];

  return (
    <nav
      aria-label={t('app.shell.sections')}
      className={cn(
        'fixed inset-x-0 bottom-0 z-30 border-t bg-background/95 pb-[env(safe-area-inset-bottom)] backdrop-blur-md supports-[backdrop-filter]:bg-background/80',
        className,
      )}
    >
      <ul className="flex h-14 items-stretch">
        {tabs.map((entry) => {
          const active = isNavEntryActive(entry, pathname);
          const Icon = entry.icon;
          return (
            <li key={entry.id} className="flex min-w-0 flex-1">
              <Link
                to={entry.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  tab,
                  active
                    ? 'font-medium text-foreground'
                    : 'text-muted-foreground hover:text-foreground',
                )}
              >
                <Icon className="size-5" aria-hidden="true" />
                <span className="max-w-full truncate">{entry.label}</span>
              </Link>
            </li>
          );
        })}
        <li className="flex min-w-0 flex-1">
          <MoreSheet entries={more} />
        </li>
      </ul>
    </nav>
  );
}
