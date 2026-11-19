import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { GanttChart, Plus } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SourceIcon } from '@/components/items/SourceIcon';
import { dateLocale, timeOfDay } from '@/components/items/format';
import { ColourDot } from '@/features/colours/ColourDot';
import { useRowColours } from '@/features/colours/useColours';
import { SourceLink } from '@/features/items/SourceLink';
import { useItemParam } from '@/features/items/useItemParam';
import { ConflictMark, LegModeIcon } from '@/features/travel/LegMark';
import { CONFLICT_EDGE, UNSET_OUTLINE, legMarksOf } from '@/features/travel/legView';
import { cn } from '@/lib/utils';
import { instantInZone } from '@/features/items/zonedDate';
import { useShellUi } from '@/features/shell/shellUi';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
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
 * the workspace's time zone. Events show their time span, tasks their due time. It has no time
 * grid to drag on (plan Ruling 18), so an editor gets a "+" per day: the New sheet on a time block
 * that day, 09:00–10:00. An editor sees every day (a free one is where a block goes); a viewer
 * sees the days that have something.
 */
export default function TimelineBlock({ dashboard, block, editing }: BlockComponentProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { openItem } = useItemParam();
  const { openNewItem } = useShellUi();
  const { role } = useCurrentWorkspace();
  const canWrite = role === 'editor' || role === 'owner';
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
  const listed = canWrite ? days : busy;
  const heading = new Intl.DateTimeFormat(locale, {
    weekday: 'long',
    day: 'numeric',
    month: 'short',
    timeZone,
  });
  const status = loadState !== 'ready' ? loadState : listed.length === 0 ? 'empty' : 'ready';
  const renderRow = (occurrence: Occurrence) => {
    const { row } = occurrence;
    // A travel leg is drawn from its props in the UI language, with its mode and flags.
    const leg = legMarksOf(t, occurrence, now);
    const label = truncateText(leg?.title ?? row.title, 160) || t('dataBlocks.noTitle');
    const time = occurrence.allDay
      ? t('timeBlocks.timeline.allDay')
      : occurrence.end === null
        ? timeOfDay(occurrence.start, locale, timeZone)
        : `${timeOfDay(occurrence.start, locale, timeZone)}–${timeOfDay(occurrence.end, locale, timeZone)}`;
    return (
      <li
        key={occurrence.key}
        data-timeline-leg={leg === null ? undefined : leg.mode}
        data-conflict={leg === null ? undefined : String(leg.conflict)}
        data-past={leg === null ? undefined : String(leg.past)}
        data-length-unset={leg === null ? undefined : String(leg.unset)}
        className={cn(
          'flex min-h-11 items-center gap-2 py-1',
          // A leg that can't be made in time has a red edge; one that is over is dimmed; one whose
          // trip has no length yet is dashed.
          leg?.conflict === true && CONFLICT_EDGE,
          leg?.past === true && 'opacity-60',
          leg?.unset === true && UNSET_OUTLINE,
        )}
      >
        <span className="w-24 shrink-0 text-[13px] text-muted-foreground tabular-nums" dir="ltr">
          {time}
        </span>
        <ColourDot colour={colourOf(row.id)} />
        {leg === null ? null : <LegModeIcon mode={leg.mode} className="text-muted-foreground" />}
        <div className="-my-1 flex min-w-0 flex-1 flex-col">
          <button
            type="button"
            // A trip with no length yet says so in its name, for anyone who can't see the dashes.
            aria-label={leg?.unset === true ? `${label}. ${t('travel.leg.setLength')}` : undefined}
            onClick={() => {
              openItem(row.id, occurrence.originalStart ?? undefined);
            }}
            className="flex min-h-11 min-w-0 items-center rounded-sm text-start text-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
            dir="auto"
          >
            <span className="min-w-0 truncate">{label}</span>
          </button>
          {leg?.conflict === true ? (
            <ConflictMark className="-mt-2 mb-1 text-xs text-destructive" />
          ) : null}
        </div>
        {occurrence.dueOnly ? (
          <span className="text-xs text-muted-foreground">{t('timeBlocks.timeline.due')}</span>
        ) : null}
        {leg === null ? (
          <>
            <SourceIcon source={displayProvider(row.source.provider)} />
            <SourceLink source={row.source} title={label} />
          </>
        ) : null}
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
        {listed.map((day) => {
          const { areas, items } = splitAreas(day.items, colourOf);
          const dayName = heading.format(day.start);
          return (
            <li key={day.date} data-timeline-day={day.date} className="flex flex-col gap-1">
              <div className="flex items-center justify-between gap-2">
                <h3 className="text-sm font-semibold">{dayName}</h3>
                {canWrite && !editing ? (
                  <Button
                    variant="ghost"
                    size="icon-sm"
                    aria-label={t('scheduled.timeline.addOn', { day: dayName })}
                    title={t('scheduled.timeline.addOn', { day: dayName })}
                    data-timeline-add={day.date}
                    onClick={() => {
                      openNewItem({
                        kind: 'block',
                        start: new Date(instantInZone(day.date, '09:00', timeZone)),
                        end: new Date(instantInZone(day.date, '10:00', timeZone)),
                      });
                    }}
                  >
                    <Plus aria-hidden="true" />
                  </Button>
                ) : null}
              </div>
              {day.items.length === 0 ? null : (
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
                        onOpen={() => {
                          openItem(area.row.id, area.originalStart ?? undefined);
                        }}
                      >
                        {group.items.length > 0 ? (
                          <ul className="m-0 list-none p-0">{group.items.map(renderRow)}</ul>
                        ) : null}
                      </TimelineAreaBand>
                    );
                  })}
                </ul>
              )}
            </li>
          );
        })}
      </ol>
    </BlockFrame>
  );
}
