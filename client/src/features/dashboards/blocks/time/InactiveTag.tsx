import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { inactiveKey } from './inactive';
import type { Inactive } from './occurrences';

/**
 * "Cancelled" or "Disabled" beside a listed occurrence (the agenda, the timeline, the clock's
 * lists): words, never only the strike-through, so its free time reads at a glance and to a
 * screen reader alike.
 */
export function InactiveTag({ inactive, className }: { inactive: Inactive; className?: string }) {
  const { t } = useTranslation();
  return (
    <span
      data-inactive={inactive}
      className={cn(
        'shrink-0 rounded-sm border border-dashed px-1 text-[11px] leading-4 text-muted-foreground',
        className,
      )}
    >
      {t(inactiveKey(inactive))}
    </span>
  );
}
