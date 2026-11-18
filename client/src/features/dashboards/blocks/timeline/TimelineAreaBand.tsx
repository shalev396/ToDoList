import type { ReactNode } from 'react';
import { useTranslation } from 'react-i18next';
import { timeOfDay } from '@/components/items/format';
import { colourVar, paintOf } from '@/features/colours/palette';
import type { ItemColour } from '@api-types/colours';

/**
 * An area on the timeline (time-blocks design, "Areas"): its tint behind the items that start
 * inside it, with its label and hours at the top and a 1px edge in the family's Scheduled step.
 * The label is always shown, even when the area holds nothing.
 */
export function TimelineAreaBand({
  title,
  start,
  end,
  colour,
  timeZone,
  locale,
  children,
}: {
  title: string;
  start: Date;
  end: Date;
  colour: ItemColour;
  timeZone: string;
  locale: string;
  children: ReactNode;
}) {
  const { t } = useTranslation();
  return (
    <li
      data-timeline-area
      data-family={colour.family}
      data-role={colour.role}
      className="my-1 rounded-md px-2 py-1"
      style={{
        backgroundColor: paintOf(colour).fill,
        boxShadow: `inset 0 0 0 1px ${colourVar(colour.family, 'scheduled')}`,
      }}
    >
      <p className="m-0 truncate text-[13px] font-medium text-foreground" dir="auto">
        {t('timeBlocks.timeline.areaRange', {
          title,
          start: timeOfDay(start, locale, timeZone),
          end: timeOfDay(end, locale, timeZone),
        })}
      </p>
      {children}
    </li>
  );
}
