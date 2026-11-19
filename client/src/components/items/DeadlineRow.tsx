import type { ReactNode } from 'react';
import { CircleAlert } from 'lucide-react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { ColourDot } from '@/features/colours/ColourDot';
import type { ItemColour } from '@api-types/colours';
import {
  browserTimeZone,
  calendarDaysFrom,
  dateLocale,
  dueText,
  isOverdue,
  relativeDay,
  shortDate,
  timeOfDay,
} from './format';
import { OpenTitle } from './OpenTitle';
import { SourceIcon } from './SourceIcon';
import type { Provider } from './types';

export interface DeadlineRowProps {
  title: string;
  source: Provider;
  due: Date;
  now: Date;
  /** IANA zone the due date is read in. Defaults to the browser's. */
  timeZone?: string | undefined;
  /** The course, project or board the item belongs to. */
  context?: string | undefined;
  /** Finished: struck through, and never shown as overdue. */
  done?: boolean | undefined;
  /**
   * Name the source in text before the context ("Moodle / Data structures"), for lists that mix
   * sources without a legend.
   */
  showSource?: boolean | undefined;
  /** Opens the item (its sheet): the title becomes a button. */
  onOpen?: (() => void) | undefined;
  /** The "Open in <provider>" slot. */
  openIn?: ReactNode;
  /** The item's colour: a dot before the title (deadlines read as Work). */
  colour?: ItemColour | undefined;
  className?: string | undefined;
}

/**
 * One deadline: source dot, title and its course or project, and when it's due as relative plus
 * absolute ("in 2 days" over "Fri 13 Nov"). Past due and not done, the critical icon and
 * "Overdue" lead.
 */
export function DeadlineRow({
  title,
  source,
  due,
  now,
  timeZone,
  context,
  done = false,
  showSource = false,
  onOpen,
  openIn,
  colour,
  className,
}: DeadlineRowProps) {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.language);
  const zone = timeZone ?? browserTimeZone();
  const days = calendarDaysFrom(now, due, zone);
  const overdue = isOverdue(due, now, done);
  const absolute =
    Math.abs(days) <= 1 ? timeOfDay(due, locale, zone) : shortDate(due, locale, zone);

  return (
    <div className={cn('flex min-h-11 items-center gap-3 py-2', className)}>
      {colour || !showSource ? (
        <span className="flex shrink-0 items-center gap-2 self-start pt-[7px]">
          {colour ? <ColourDot colour={colour} /> : null}
          {showSource ? null : <SourceIcon source={source} />}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <OpenTitle
          as="p"
          title={title}
          onOpen={onOpen}
          className={cn(
            'truncate text-sm',
            done ? 'text-muted-foreground line-through' : 'text-foreground',
          )}
        >
          {title}
          {done ? <span className="sr-only">, {t('items.done')}</span> : null}
        </OpenTitle>
        {showSource || context ? (
          <p className="flex items-center text-[13px] text-muted-foreground">
            {showSource ? <SourceIcon source={source} showName /> : null}
            {showSource && context ? (
              <span aria-hidden="true" className="mx-1.5 text-border">
                /
              </span>
            ) : null}
            {showSource && context ? <span className="sr-only">, </span> : null}
            {context ? <span className="truncate">{context}</span> : null}
          </p>
        ) : null}
      </div>
      <p className="shrink-0 text-end text-[13px] leading-tight tabular-nums">
        <span className="sr-only">
          {overdue ? `${t('items.overdue')}, ` : ''}
          {dueText(due, now, locale, zone)}
        </span>
        <span aria-hidden="true" className="flex flex-col items-end gap-0.5">
          {overdue ? (
            <span className="inline-flex items-center gap-1 text-foreground">
              <CircleAlert className="size-3.5 text-status-critical" />
              {t('items.overdue')}
            </span>
          ) : (
            <span className={cn(days <= 1 ? 'text-foreground' : 'text-muted-foreground')}>
              {relativeDay(days, locale)}
            </span>
          )}
          <span className="text-muted-foreground">
            {overdue ? relativeDay(days, locale) : absolute}
          </span>
        </span>
      </p>
      {openIn}
    </div>
  );
}
