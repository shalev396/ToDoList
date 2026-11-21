import { useTranslation } from 'react-i18next';
import { colourVar } from '@/features/colours/palette';
import type { AreaTag } from '../calendar/calendarEvents';
import { isolateLtr } from '../time/areas';

/**
 * An area named in its day's header on the timesheet's week: a tag in the area's tint and edge
 * that opens its sheet (the dependable way in; the band itself opens it on a tap too). The
 * calendar block draws the same tag (its own AreaTagButton, left as it is).
 */
export function TimesheetAreaTag({ tag, onOpen }: { tag: AreaTag; onOpen: () => void }) {
  const { t } = useTranslation();
  const when =
    tag.from === null
      ? t('timeBlocks.calendar.allDay')
      : isolateLtr(tag.to === null ? tag.from : `${tag.from}–${tag.to}`);
  const name = t('timeBlocks.calendar.areaLabel', { title: tag.title, when });
  return (
    <button
      type="button"
      data-area-tag={tag.rowId}
      aria-label={name}
      title={name}
      onClick={onOpen}
      className="block min-h-5 w-full min-w-0 cursor-pointer truncate rounded-sm border px-1 text-[11px] leading-4 font-medium text-foreground focus-visible:outline-2 focus-visible:outline-offset-1 focus-visible:outline-ring pointer-coarse:min-h-6"
      style={{
        backgroundColor: colourVar(tag.family, 'area'),
        borderColor: colourVar(tag.family, 'scheduled'),
      }}
    >
      <span dir="auto">{tag.title}</span>
    </button>
  );
}
