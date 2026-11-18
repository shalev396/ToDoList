import { useTranslation } from 'react-i18next';
import { Bus, Car, Footprints, TriangleAlert, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { TravelMode } from '@api-types/travel.ts';

const MODE_ICONS: Record<TravelMode, LucideIcon> = {
  walk: Footprints,
  drive: Car,
  transit: Bus,
};

/** The mode's icon (a footprint, a car, a bus): decorative, the title names the trip. */
export function LegModeIcon({ mode, className }: { mode: TravelMode; className?: string }) {
  const Icon = MODE_ICONS[mode];
  return (
    <Icon aria-hidden="true" data-leg-mode={mode} className={cn('size-3.5 shrink-0', className)} />
  );
}

/**
 * "You can't make it": the warning icon and the words, so the red edge is never the only signal.
 * The words take the colour around them unless `tone` says red (on the page surface).
 */
export function ConflictMark({
  className,
  wordsClassName,
  tone,
}: {
  className?: string;
  /** On the words alone (a view may hide them where there is no room: the icon stays). */
  wordsClassName?: string;
  tone?: 'destructive';
}) {
  const { t } = useTranslation();
  return (
    <span
      data-leg-conflict-label=""
      className={cn(
        'inline-flex shrink-0 items-center gap-1 font-medium',
        tone === 'destructive' && 'text-destructive',
        className,
      )}
    >
      <TriangleAlert aria-hidden="true" className="size-3 shrink-0" />
      <span className={wordsClassName}>{t('travel.leg.conflict')}</span>
    </span>
  );
}
