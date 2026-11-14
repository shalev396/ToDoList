import { useTranslation } from 'react-i18next';
import { CalendarClock, User } from 'lucide-react';
import { SourceDot } from '@/components/items/SourceDot';
import { dateLocale, dueText } from '@/components/items/format';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import type { ItemDetail } from '@api-types/api-contracts';
import { SourceLink } from './SourceLink';
import { isKnownProvider } from './providers';
import { assigneeNames } from './itemFields';
import { StatusLabel } from './itemStatus';

export interface SourcePreviewProps {
  item: Pick<ItemDetail, 'title' | 'status' | 'dueAt' | 'assignees' | 'props' | 'source'>;
  /** The workspace's time zone (IANA). */
  timeZone: string;
  className?: string;
}

/**
 * What the source says about an item, from data: its provider, status, due date and assignee,
 * and the link back. The sheet shows it; it never shows an edit control (the source owns it).
 */
export function SourcePreview({ item, timeZone, className }: SourcePreviewProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const due = item.dueAt === null ? null : new Date(item.dueAt);
  const names = assigneeNames(item).join(', ');
  return (
    <section
      aria-label={t('items.sheet.source', { source: t(`sources.${item.source.provider}`) })}
      className={cn('flex flex-col gap-2.5 rounded-lg border bg-card p-3.5 text-sm', className)}
    >
      {isKnownProvider(item.source.provider) ? (
        <SourceDot
          source={item.source.provider}
          showName
          className="text-[13px] text-muted-foreground"
        />
      ) : null}
      <dl className="flex flex-col gap-2">
        <div className="flex items-center gap-2">
          <dt className="sr-only">{t('items.sheet.status')}</dt>
          <dd>
            <StatusLabel status={item.status} />
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="sr-only">{t('items.sheet.due')}</dt>
          <dd className="flex items-center gap-1.5">
            <CalendarClock aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            {due === null
              ? t('items.sheet.noDue')
              : dueText(due, new Date(), dateLocale(language), timeZone)}
          </dd>
        </div>
        <div className="flex items-center gap-2">
          <dt className="sr-only">{t('items.sheet.assignee')}</dt>
          <dd className="flex min-w-0 items-center gap-1.5">
            <User aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="truncate" dir="auto" title={names === '' ? undefined : names}>
              {names === '' ? t('items.sheet.nobody') : names}
            </span>
          </dd>
        </div>
      </dl>
      {item.source.provider === 'local' ? null : (
        <SourceLink
          source={item.source}
          title={item.title}
          variant="label"
          className="self-start"
        />
      )}
    </section>
  );
}
