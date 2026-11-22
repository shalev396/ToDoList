import { useTranslation } from 'react-i18next';
import { cn } from '@/lib/utils';
import { inactiveKey } from './inactive';
import type { Inactive } from './occurrences';

/**
 * "Cancelled" or "Disabled" beside a listed occurrence (the agenda, the timeline, the clock's
 * lists): words, never only the strike-through, so its free time reads at a glance and to a
 * screen reader alike. `silent` when the row's own name already says it (read once, not twice).
 */
export function InactiveTag({
  inactive,
  className,
  silent = false,
}: {
  inactive: Inactive;
  className?: string;
  silent?: boolean;
}) {
  const { t } = useTranslation();
  return (
    <span
      aria-hidden={silent ? true : undefined}
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
