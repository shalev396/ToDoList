import { useState, type ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { cn } from '@/lib/utils';
import { TONE_CLASS } from './tone';
import type { Tone } from '../../rules/applyDisplayRules';
import { ScrollArea } from '@/components/ui/scroll-area';

export function ToneRow({
  tone,
  className,
  children,
}: {
  tone: Tone | undefined;
  className?: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <div
      className={cn(
        'min-w-0',
        tone === undefined ? undefined : cn('border-s-2 ps-2', TONE_CLASS[tone]),
        className,
      )}
    >
      {tone === undefined ? null : (
        <span className="sr-only">{t(`dataBlocks.tone.${tone}`)}. </span>
      )}
      {children}
    </div>
  );
}

/** "P1" to "P4" for priorities 1 to 4; 0 and null (none) show nothing. */
export function PriorityChip({ priority }: { priority: number | null }) {
  const { t } = useTranslation();
  if (priority === null || priority < 1) {
    return null;
  }
  return (
    <span
      title={t('dataBlocks.priorityLabel', { level: priority })}
      className="inline-flex h-6 shrink-0 items-center rounded-full bg-sunken px-2 text-xs font-medium whitespace-nowrap text-foreground"
    >
      <span aria-hidden="true">{t('dataBlocks.priority', { level: priority })}</span>
      <span className="sr-only">{t('dataBlocks.priorityLabel', { level: priority })}</span>
    </span>
  );
}

/** Badges a display rule adds (their text is the author's data). */
export function BadgeChips({ badges }: { badges: readonly string[] }) {
  return (
    <>
      {badges.map((badge) => (
        <span
          key={badge}
          className="inline-flex h-6 max-w-24 shrink-0 items-center truncate rounded-full border px-2 text-xs text-foreground"
        >
          {badge}
        </span>
      ))}
    </>
  );
}

/**
 * The block footer's "Show all N": opens the complete list in a Sheet (rows past the visible ones).
 */
export function ShowAll({
  title,
  count,
  children,
}: {
  title: string;
  count: number;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button
        variant="ghost"
        size="sm"
        onClick={() => {
          setOpen(true);
        }}
      >
        {t('dataBlocks.showAll', { count })}
      </Button>
      <Sheet open={open} onOpenChange={setOpen}>
        <SheetContent
          aria-describedby={undefined}
          closeLabel={t('dataBlocks.close')}
          className="w-[min(32rem,100vw)] sm:max-w-lg"
        >
          <SheetHeader>
            <SheetTitle className="truncate pe-10" title={title}>
              {t('dataBlocks.showAllTitle', { title })}
            </SheetTitle>
          </SheetHeader>
          <ScrollArea focusable className="min-h-0 flex-1">
            <div className="px-4 pb-4">{children}</div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </>
  );
}
