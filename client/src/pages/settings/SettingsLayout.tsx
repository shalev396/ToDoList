import type { ReactNode } from 'react';
import { Link, useLocation } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { Info } from 'lucide-react';
import { cn } from '@/lib/utils';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import { PageContainer, PageHeader } from '@/features/shell/PageHeader';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';

/** General | Members | Agent keys | Travel (editors and owners: it is their own), under the title. */
function SettingsTabs() {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { pathname } = useLocation();
  const { role } = useCurrentWorkspace();
  const tabs = [
    { to: pathTo(ROUTES.SETTINGS, language), label: t('settings.tabs.general') },
    { to: pathTo(ROUTES.MEMBERS, language), label: t('settings.tabs.members') },
    { to: pathTo(ROUTES.AGENT_KEYS, language), label: t('settings.tabs.agentKeys') },
    ...(role === 'owner' || role === 'editor'
      ? [{ to: pathTo(ROUTES.TRAVEL, language), label: t('travel.tab') }]
      : []),
  ];
  return (
    <nav aria-label={t('settings.tabs.label')} className="-mb-px border-b">
      <ul className="flex flex-wrap gap-x-5">
        {tabs.map((tab) => {
          const active = pathname === tab.to;
          return (
            <li key={tab.to}>
              <Link
                to={tab.to}
                aria-current={active ? 'page' : undefined}
                className={cn(
                  'inline-flex min-h-11 min-w-11 items-center justify-center border-b-2 text-sm pointer-fine:min-h-10 pointer-fine:min-w-0 transition-colors focus-visible:rounded-xs focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
                  active
                    ? 'border-foreground font-medium text-foreground'
                    : 'border-transparent text-muted-foreground hover:text-foreground',
                )}
              >
                {tab.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}

/**
 * The settings pages' frame: the workspace's name, the tabs, a reading-width column. A `personal`
 * page (Travel: each member's own) has no "only owners can change these" note.
 */
export function SettingsFrame({
  children,
  personal = false,
}: {
  children: ReactNode;
  personal?: boolean;
}) {
  const { t } = useTranslation();
  const { workspace, role, isOwner } = useCurrentWorkspace();
  return (
    <PageContainer width="reading">
      <PageHeader
        title={isOwner ? t('settings.title') : t('app.shell.workspace')}
        description={workspace?.name}
      >
        <SettingsTabs />
      </PageHeader>
      {isOwner || role === null || personal ? null : (
        <p className="mb-6 flex items-start gap-2 rounded-sm bg-sunken px-3 py-2.5 text-sm text-muted-foreground">
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t(`settings.readOnly.${role === 'editor' ? 'editor' : 'viewer'}`)}</span>
        </p>
      )}
      {/* One parent for the sections, so the first one drops its top hairline. */}
      <div>{children}</div>
    </PageContainer>
  );
}

/**
 * One settings section: its title and a line of explanation on the start side, the controls on
 * the end side (stacked on phones). Sections are separated by hairlines, not boxed.
 */
export function SettingsSection({
  title,
  hint,
  children,
  id,
  layout = 'split',
}: {
  title: string;
  hint?: ReactNode;
  children: ReactNode;
  id: string;
  /** `stacked`: the title above, for lists that need the column's whole width. */
  layout?: 'split' | 'stacked';
}) {
  return (
    <section
      aria-labelledby={id}
      className={cn(
        'grid grid-cols-1 gap-x-10 gap-y-4 border-t py-8 first:border-t-0 first:pt-2',
        layout === 'split' && '@2xl:grid-cols-[200px_minmax(0,1fr)]',
      )}
    >
      <div className="flex flex-col gap-1">
        <h2 id={id} className="text-base leading-snug font-semibold">
          {title}
        </h2>
        {hint === undefined ? null : (
          <p className="text-[13px] text-pretty text-muted-foreground">{hint}</p>
        )}
      </div>
      <div className="flex min-w-0 flex-col gap-5">{children}</div>
    </section>
  );
}
