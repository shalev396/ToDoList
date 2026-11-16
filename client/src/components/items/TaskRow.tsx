import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { DueChip } from './DueChip';
import { OpenTitle } from './OpenTitle';
import { SourceDot } from './SourceDot';
import type { Provider } from './types';

export interface TaskRowProps {
  title: string;
  source: Provider;
  now: Date;
  due?: Date | undefined;
  /** IANA zone the due date is read in. Defaults to the browser's. */
  timeZone?: string | undefined;
  done?: boolean | undefined;
  /**
   * The round checkbox slot (see RoundCheckbox). Items mirrored from a provider can't be completed
   * here, so callers leave it out and the row keeps the space to align titles.
   */
  checkbox?: ReactNode;
  /** Small chips between the title and the due chip: priority, display-rule badges. */
  meta?: ReactNode;
  /** Opens the item (its sheet): the title becomes a button. */
  onOpen?: (() => void) | undefined;
  /** The "Open in <provider>" slot. */
  openIn?: ReactNode;
  className?: string | undefined;
}

/** A Todoist-style task row: checkbox, title, due chip, source dot and an open-in slot. */
export function TaskRow({
  title,
  source,
  now,
  due,
  timeZone,
  done = false,
  checkbox,
  meta,
  onOpen,
  openIn,
  className,
}: TaskRowProps) {
  const { t } = useTranslation();

  return (
    <div className={cn('flex min-h-11 items-center gap-2 pointer-fine:min-h-9', className)}>
      {checkbox ?? <span aria-hidden="true" className="w-7 shrink-0 pointer-fine:w-6" />}
      <OpenTitle
        as="span"
        title={title}
        onOpen={onOpen}
        className={cn(
          'min-w-0 flex-1 truncate text-sm transition-colors duration-150',
          done
            ? 'text-muted-foreground line-through decoration-muted-foreground/60'
            : 'text-foreground',
        )}
      >
        {title}
        {/* Without a checkbox nothing else tells assistive tech the item is finished. */}
        {done && !checkbox ? <span className="sr-only">, {t('items.done')}</span> : null}
      </OpenTitle>
      {meta}
      {due ? <DueChip due={due} now={now} timeZone={timeZone} done={done} /> : null}
      <SourceDot source={source} className="px-1" />
      {openIn}
    </div>
  );
}
