import { useTranslation } from 'react-i18next';
import { timeOfDay } from '@/components/items/format';
import { ColourDot } from '@/features/colours/ColourDot';
import { cn } from '@/lib/utils';
import { isolateAuto, isolateLtr } from '../time/areas';
import { INACTIVE_TITLE } from '../time/inactive';
import { InactiveTag } from '../time/InactiveTag';
import type { Inactive } from '../time/occurrences';
import type { ItemColour } from '@api-types/colours';

/**
 * An area's section header in the agenda: "Studying 13:00–17:00" with its colour; with `onOpen`
 * it is a button that opens the area's sheet on that occurrence. A cancelled or disabled one is
 * struck through, with its tag.
 */
export function AgendaAreaHeader({
  title,
  start,
  end,
  colour,
  timeZone,
  locale,
  onOpen,
  inactive = null,
}: {
  title: string;
  start: Date;
  end: Date;
  inactive?: Inactive | null;
  colour: ItemColour;
  timeZone: string;
  locale: string;
  onOpen?: () => void;
}) {
  const { t } = useTranslation();
  const label = t('timeBlocks.agenda.areaRange', {
    title: isolateAuto(title),
    range: isolateLtr(`${timeOfDay(start, locale, timeZone)}–${timeOfDay(end, locale, timeZone)}`),
  });
  return (
    <div className="flex items-center gap-2 pt-1.5 text-[13px] font-medium text-foreground">
      <ColourDot colour={colour} />
      {onOpen === undefined ? (
        <span className={cn('truncate text-start', inactive !== null && INACTIVE_TITLE)}>
          {label}
        </span>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className={cn(
            'max-w-full truncate rounded-sm py-0.5 text-start hover:underline pointer-coarse:min-h-11 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
            inactive !== null && INACTIVE_TITLE,
          )}
        >
          {label}
        </button>
      )}
      {inactive === null ? null : <InactiveTag inactive={inactive} />}
    </div>
  );
}
