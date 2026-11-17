import { useTranslation } from 'react-i18next';
import { CircleCheck, Lock } from 'lucide-react';
import { dateLocale } from '@/components/items/format';
import { sourceNameKey } from '@/components/items/sources';
import { DEMO_CONNECTION } from '../demoData';
import { Block } from '../layout';
import { ProviderIcon } from '../ProviderIcon';

/** A connected source as the app shows it: status and last sync, and a token that stays sealed. */
export function PrivacyDemo() {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.language);
  const synced = new Intl.RelativeTimeFormat(locale, { numeric: 'auto' }).format(
    -DEMO_CONNECTION.syncedMinutesAgo,
    'minute',
  );

  return (
    <Block className="p-4">
      <div className="flex items-center gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-sm border bg-background">
          <ProviderIcon name={DEMO_CONNECTION.source} className="size-[18px]" />
        </span>
        <div className="min-w-0 flex-1">
          <p className="text-sm font-medium">{t(sourceNameKey(DEMO_CONNECTION.source))}</p>
          <p className="truncate text-[13px] text-muted-foreground">{DEMO_CONNECTION.account}</p>
        </div>
        <span className="flex shrink-0 items-center gap-1.5 text-[13px]">
          <CircleCheck aria-hidden="true" className="size-4 text-status-good" />
          {t('landing.privacy.status')}
        </span>
      </div>
      <div className="mt-5">
        <p className="text-[13px] font-medium">{t('landing.privacy.token')}</p>
        <p className="mt-1.5 flex h-9 items-center gap-2 rounded-sm border bg-sunken px-3 text-sm text-muted-foreground">
          <Lock aria-hidden="true" className="size-4 shrink-0" />
          {t('landing.privacy.sealed')}
        </p>
        <p className="mt-2 text-[13px] text-muted-foreground">{t('landing.privacy.saved')}</p>
      </div>
      <p className="mt-5 border-t pt-3 text-xs text-muted-foreground">
        {t('landing.privacy.synced', { when: synced })}
      </p>
    </Block>
  );
}
