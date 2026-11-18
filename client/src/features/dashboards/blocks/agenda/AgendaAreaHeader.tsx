import { useTranslation } from 'react-i18next';
import { timeOfDay } from '@/components/items/format';
import { ColourDot } from '@/features/colours/ColourDot';
import type { ItemColour } from '@api-types/colours';

/** An area's section header in the agenda: "Studying 13:00–17:00" with its colour. */
export function AgendaAreaHeader({
  title,
  start,
  end,
  colour,
  timeZone,
  locale,
}: {
  title: string;
  start: Date;
  end: Date;
  colour: ItemColour;
  timeZone: string;
  locale: string;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex items-center gap-2 pt-1.5 text-[13px] font-medium text-foreground">
      <ColourDot colour={colour} />
      <span className="truncate" dir="auto">
        {t('timeBlocks.agenda.areaRange', {
          title,
          start: timeOfDay(start, locale, timeZone),
          end: timeOfDay(end, locale, timeZone),
        })}
      </span>
    </div>
  );
}
