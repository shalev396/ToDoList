import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GanttChart } from 'lucide-react';
import { SourceIcon } from '@/components/items/SourceIcon';
import { dateLocale, timeOfDay } from '@/components/items/format';
import { ColourDot } from '@/features/colours/ColourDot';
import { useRowColours } from '@/features/colours/useColours';
import { SourceLink } from '@/features/items/SourceLink';
import { useItemParam } from '@/features/items/useItemParam';
import { useLanguage } from '@/hooks/useLanguage';
import { BlockFrame } from '../../BlockFrame';
import { blockTitle } from '../../chrome';
import type { BlockComponentProps } from '../../registry/types';
import { displayProvider } from '../data/rows';
import { truncateText } from '../data/truncate';
import { useDataBlock } from '../data/useDataBlock';
import { endOfZonedDay, startOfZonedDay } from '../clock/ClockRing.math';
import { nestInAreas, splitAreas } from '../time/areas';
import { expandOccurrences, wallDate, type Occurrence } from '../time/occurrences';
import { TimelineAreaBand } from './TimelineAreaBand';

const DEFAULT_DAYS = 7;

function daysOf(viz: Record<string, unknown>): number {
  const value = viz['days'];
  return typeof value === 'number' && value >= 1 ? Math.floor(value) : DEFAULT_DAYS;
}

interface Day {
  date: string;
  start: Date;
  items: Occurrence[];
}

/**
 * The timeline (H3): the next days one under another on a rail, each with what happens on it, in
 * the workspace's time zone. Events show their time span, tasks their due time.
 */
export default function TimelineBlock({ dashboard, block }: BlockComponentProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { openItem } = useItemParam();
  const { query, rows, loadState, now, timeZone } = useDataBlock(dashboard, block);
  const title = blockTitle(block, t);
  const locale = dateLocale(language);
  const count = daysOf(block.viz);
  const itemRows = useMemo(() => rows.map((entry) => entry.row), [rows]);
  const colourOf = useRowColours(itemRows);
  const days = useMemo((): Day[] => {
    const out: Day[] = [];
    let start = startOfZonedDay(now, timeZone);
    const first = start;
    for (let index = 0; index < count; index += 1) {
      const end = endOfZonedDay(start, timeZone);
      out.push({ date: wallDate(start, timeZone), start, items: [] });
      start = end;
    }
    const occurrences = expandOccurrences(
      rows.map((entry) => entry.row),
      { from: first, to: start },
      timeZone,
    );
    for (const occurrence of occurrences) {
      const date = wallDate(occurrence.start, timeZone);
      out.find((day) => day.date === date)?.items.push(occurrence);
    }
    return out;
  }, [rows, now, timeZone, count]);
  const busy = days.filter((day) => day.items.length > 0);
  const heading = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone,
  });
  const status = loadState !== 'ready' ? loadState : busy.length === 0 ? 'empty' : 'ready';
  const renderRow = (occurrence: Occurrence) => {
    const { row } = occurrence;
    const label = truncateText(row.title, 160) || t('dataBlocks.noTitle');
    const time = occurrence.allDay
      ? t('timeBlocks.timeline.allDay')
      : occurrence.end === null
        ? timeOfDay(occurrence.start, locale, timeZone)
        : `${timeOfDay(occurrence.start, locale, timeZone)}–${timeOfDay(occurrence.end, locale, timeZone)}`;
    return (
      <li key={occurrence.key} className="flex min-h-11 items-center gap-2 py-1">
        <span className="w-24 shrink-0 text-[13px] text-muted-foreground tabular-nums" dir="ltr">
          {time}
        </span>
        <ColourDot colour={colourOf(row.id)} />
        <button
          type="button"
          onClick={() => {
            openItem(row.id);
          }}
          className="min-w-0 flex-1 truncate rounded-sm text-start text-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
          dir="auto"
        >
          {label}
        </button>
        {occurrence.dueOnly ? (
          <span className="text-xs text-muted-foreground">{t('timeBlocks.timeline.due')}</span>
        ) : null}
        <SourceIcon source={displayProvider(row.source.provider)} />
        <SourceLink source={row.source} title={label} />
      </li>
    );
  };
  return (
    <BlockFrame
      title={title}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<GanttChart />}
      emptyMessage={t('timeBlocks.timeline.empty', { count })}
    >
      <ol data-timeline className="m-0 flex list-none flex-col gap-4 p-0">
        {busy.map((day) => {
          const { areas, items } = splitAreas(day.items, colourOf);
          return (
            <li key={day.date} data-timeline-day={day.date} className="flex flex-col gap-1">
              <h3 className="text-sm font-semibold">{heading.format(day.start)}</h3>
              <ul className="m-0 list-none border-s-2 ps-3 p-0">
                {nestInAreas(items, areas).map((group) => {
                  const { area } = group;
                  if (area === null) {
                    return group.items.map(renderRow);
                  }
                  return (
                    <TimelineAreaBand
                      key={area.key}
                      title={truncateText(area.row.title, 160) || t('dataBlocks.noTitle')}
                      start={area.start}
                      end={area.end ?? area.start}
                      colour={colourOf(area.row.id)}
                      timeZone={timeZone}
                      locale={locale}
                    >
                      {group.items.length > 0 ? (
                        <ul className="m-0 list-none p-0">{group.items.map(renderRow)}</ul>
                      ) : null}
                    </TimelineAreaBand>
                  );
                })}
              </ul>
            </li>
          );
        })}
      </ol>
    </BlockFrame>
  );
}
