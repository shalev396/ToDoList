import { useTranslation } from 'react-i18next';
import { UserPlus } from 'lucide-react';
import { initials } from '@/components/items/format';
import { cn } from '@/lib/utils';
import { demoLanguage, demoMembers, demoWorkspaceName } from '../demoData';
import { Block, BlockHeader } from '../layout';

/** A workspace's members: who can edit, who can only view, and who sees only College. */
export function SharingDemo() {
  const { t, i18n } = useTranslation();
  const lang = demoLanguage(i18n.language);
  const members = demoMembers(lang);

  return (
    <Block>
      <BlockHeader
        title={demoWorkspaceName(lang)}
        aside={
          <span
            aria-hidden="true"
            className="flex items-center gap-1.5 rounded-sm border px-2.5 py-1 text-foreground"
          >
            <UserPlus className="size-3.5" />
            {t('landing.sharing.invite')}
          </span>
        }
      />
      <ul aria-label={t('landing.sharing.members')} className="divide-y border-t px-4">
        {members.map((member) => (
          <li key={member.id} className="flex min-h-14 items-center gap-3 py-2">
            <span
              aria-hidden="true"
              className="flex size-8 shrink-0 items-center justify-center rounded-full bg-sunken text-xs font-medium"
            >
              {initials(member.name)}
            </span>
            <span className="min-w-0 flex-1 truncate text-sm">{member.name}</span>
            <span className="w-16 shrink-0 text-[13px] text-muted-foreground sm:w-20">
              {t(`landing.roles.${member.role}`)}
            </span>
            <span
              className={cn(
                'inline-flex h-6 shrink-0 items-center rounded-full border px-2 text-xs',
                member.scope === 'college'
                  ? 'border-foreground text-foreground'
                  : 'text-muted-foreground',
              )}
            >
              <span className="sr-only">{t('landing.sharing.access')}: </span>
              {t(`landing.scopes.${member.scope}`)}
            </span>
          </li>
        ))}
      </ul>
    </Block>
  );
}
