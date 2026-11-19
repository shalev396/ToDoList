import { useTranslation } from 'react-i18next';
import { timeOfDay } from '@/components/items/format';
import { ColourDot } from '@/features/colours/ColourDot';
import { isolateAuto, isolateLtr } from '../time/areas';
import type { ItemColour } from '@api-types/colours';

/**
 * An area's section header in the agenda: "Studying 13:00–17:00" with its colour; with `onOpen`
 * it is a button that opens the area's sheet on that occurrence.
 */
export function AgendaAreaHeader({
  title,
  start,
  end,
  colour,
  timeZone,
  locale,
  onOpen,
}: {
  title: string;
  start: Date;
  end: Date;
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
        <span className="truncate text-start">{label}</span>
      ) : (
        <button
          type="button"
          onClick={onOpen}
          className="max-w-full truncate rounded-sm py-0.5 text-start hover:underline pointer-coarse:min-h-11 focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
        >
          {label}
        </button>
      )}
    </div>
  );
}
