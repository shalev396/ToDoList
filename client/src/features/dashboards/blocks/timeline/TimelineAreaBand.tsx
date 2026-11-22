import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { timeOfDay } from '@/components/items/format';
import { markStyle } from '@/features/colours/palette';
import { cn } from '@/lib/utils';
import { isolateAuto, isolateLtr } from '../time/areas';
import { INACTIVE_TITLE } from '../time/inactive';
import { InactiveTag } from '../time/InactiveTag';
import type { Inactive } from '../time/occurrences';
import type { ItemColour } from '@api-types/colours';

/**
 * An area on the timeline (time-blocks design, "Areas"): its tint behind the items that start
 * inside it, with its label and hours at the top and a 1px edge in the family's Scheduled step.
 * The label is always shown, even when the area holds nothing; with `onOpen` it opens the area's
 * sheet (its time, repeat and page; edit, skip, delete). A cancelled or disabled one is faded and
 * struck through, with its tag.
 */
export function TimelineAreaBand({
  title,
  start,
  end,
  colour,
  timeZone,
  locale,
  onOpen,
  children,
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
  children: ReactNode;
}) {
  const { t } = useTranslation();
  const label = t('timeBlocks.timeline.areaRange', {
    title: isolateAuto(title),
    range: isolateLtr(`${timeOfDay(start, locale, timeZone)}–${timeOfDay(end, locale, timeZone)}`),
  });
  return (
    <li
      data-timeline-area
      data-family={colour.family}
      data-role={colour.role}
      data-inactive={inactive ?? undefined}
      className="my-1 rounded-md px-2 py-1"
      style={markStyle(colour)}
    >
      <div className="flex min-w-0 items-center gap-2">
        {onOpen === undefined ? (
          <p
            className={cn(
              'm-0 truncate text-start text-[13px] font-medium text-foreground',
              inactive !== null && INACTIVE_TITLE,
            )}
          >
            {label}
          </p>
        ) : (
          <button
            type="button"
            onClick={onOpen}
            className={cn(
              'block max-w-full truncate rounded-sm text-start text-[13px] pointer-coarse:min-h-11 font-medium text-foreground hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none',
              inactive !== null && INACTIVE_TITLE,
            )}
          >
            {label}
          </button>
        )}
        {inactive === null ? null : <InactiveTag inactive={inactive} />}
      </div>
      {children}
    </li>
  );
}
