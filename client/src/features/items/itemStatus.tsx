import { useTranslation } from 'react-i18next';
import { Circle, CircleCheck, CircleDot, CircleX, type LucideIcon } from 'lucide-react';
import { cn } from '@/lib/utils';
import type { ItemStatus } from '@api-types/domain';

const ICONS: Record<ItemStatus, LucideIcon> = {
  open: Circle,
  in_progress: CircleDot,
  done: CircleCheck,
  cancelled: CircleX,
};

/** A status with its icon and label: colour is never the only cue. */
export function StatusLabel({ status, className }: { status: ItemStatus; className?: string }) {
  const { t } = useTranslation();
  const Icon = ICONS[status];
  return (
    <span className={cn('inline-flex items-center gap-1.5', className)}>
      <Icon
        aria-hidden="true"
        className={cn(
          'size-4 shrink-0',
          status === 'done' ? 'text-success' : 'text-muted-foreground',
        )}
      />
      {t(`items.statuses.${status}`)}
    </span>
  );
}
