import { CircleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { browserTimeZone, dateLocale, dueChipText, dueText, isOverdue } from './format';

export interface DueChipProps {
  due: Date;
  now: Date;
  /** IANA zone the dates are read in. Defaults to the browser's. */
  timeZone?: string | undefined;
  /** A finished item is never overdue. */
  done?: boolean | undefined;
  className?: string | undefined;
}

/**
 * A pill with when something is due: "Today", "Tomorrow" or "Fri 13 Nov". Past due (and not done)
 * it shows the critical status icon with the label "Overdue".
 */
export function DueChip({ due, now, timeZone, done = false, className }: DueChipProps) {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.language);
  const zone = timeZone ?? browserTimeZone();
  const overdue = isOverdue(due, now, done);
  const full = dueText(due, now, locale, zone);

  return (
    <span
      title={full}
      className={cn(
        'inline-flex h-6 shrink-0 items-center gap-1 rounded-full bg-sunken px-2 text-xs whitespace-nowrap tabular-nums text-muted-foreground',
        overdue && 'text-foreground',
        className,
      )}
    >
      {overdue ? (
        <>
          <CircleAlert aria-hidden="true" className="size-3.5 text-status-critical" />
          {t('items.overdue')}
          <span className="sr-only">{`, ${full}`}</span>
        </>
      ) : (
        dueChipText(due, now, locale, zone)
      )}
    </span>
  );
}
