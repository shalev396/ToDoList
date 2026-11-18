import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { paintOf } from '@/features/colours/palette';
import type { ItemColour } from '@api-types/colours';
import { DueChip } from './DueChip';
import { initials } from './format';
import { OpenTitle } from './OpenTitle';
import { SourceIcon } from './SourceIcon';
import type { Provider } from './types';

export interface BoardCardProps {
  title: string;
  source: Provider;
  now: Date;
  /** A short reference such as a ticket key ("PAY-142"). */
  reference?: string | undefined;
  due?: Date | undefined;
  /** IANA zone the due date is read in. Defaults to the browser's. */
  timeZone?: string | undefined;
  /** Name of the person it's assigned to; the card shows their initials. */
  assignee?: string | undefined;
  /** Opens the item (its sheet): the title becomes a button. */
  onOpen?: (() => void) | undefined;
  /** The "Open in <provider>" slot. */
  openIn?: ReactNode;
  /** The item's colour (topic family and role): a 4px edge at the card's start. */
  colour?: ItemColour | undefined;
  className?: string | undefined;
}

/** A Trello-style card for board columns: title, then source, reference, due date and assignee. */
export function BoardCard({
  title,
  source,
  now,
  reference,
  due,
  timeZone,
  assignee,
  onOpen,
  openIn,
  colour,
  className,
}: BoardCardProps) {
  const { t } = useTranslation();

  return (
    <div
      data-family={colour?.family}
      data-role={colour?.role}
      className={cn('rounded-md border bg-card p-3', colour && 'border-s-4', className)}
      style={colour ? { borderInlineStartColor: paintOf(colour).fill } : undefined}
    >
      <div className="flex items-start gap-2">
        <OpenTitle
          as="p"
          title={title}
          onOpen={onOpen}
          className="line-clamp-2 min-w-0 flex-1 text-sm text-foreground"
        >
          {title}
        </OpenTitle>
        {openIn}
      </div>
      <div className="mt-2.5 flex items-center gap-2 text-xs text-muted-foreground">
        <SourceIcon source={source} />
        {reference ? <span className="truncate tabular-nums">{reference}</span> : null}
        <span className="flex-1" />
        {due ? <DueChip due={due} now={now} timeZone={timeZone} /> : null}
        {assignee ? (
          <span
            role="img"
            aria-label={t('items.assignedTo', { name: assignee })}
            title={assignee}
            className="flex size-6 shrink-0 items-center justify-center rounded-full bg-sunken text-[11px] font-medium text-foreground"
          >
            {initials(assignee)}
          </span>
        ) : null}
      </div>
    </div>
  );
}
