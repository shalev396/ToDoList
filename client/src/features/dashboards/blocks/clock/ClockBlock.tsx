import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlockData } from '@/api/queries/blocks';
import { dateLocale, longDate, timeOfDay } from '@/components/items/format';
import { SourceIcon } from '@/components/items/SourceIcon';
import { sourceNameKey } from '@/components/items/sources';
import { ColourDot } from '@/features/colours/ColourDot';
import { useRowColours } from '@/features/colours/useColours';
import { SourceLink } from '@/features/items/SourceLink';
import { ConflictMark, LegModeIcon } from '@/features/travel/LegMark';
import { legMarksOf, rowTitle, type LegMarks } from '@/features/travel/legView';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import { useNow } from '@/hooks/useNow';
import { BlockFrame } from '../../BlockFrame';
import { blockTitle } from '../../chrome';
import type { BlockComponentProps } from '../../registry/types';
import { applyDisplayRules } from '../../rules/applyDisplayRules';
import { usePageVars } from '../../variables/pageVars';
import type { ItemQueryRow, QueryRow } from '@api-types/builder';
import type { ItemColour } from '@api-types/colours';
import { INACTIVE_TITLE, inactiveKey } from '../time/inactive';
import { InactiveTag } from '../time/InactiveTag';
import type { Occurrence } from '../time/occurrences';
import {
  buildClockModel,
  ringProvider,
  tomorrowOf,
  type ClockArea,
  type ClockEvent,
} from './clockModel';
import { ClockLegend } from './ClockLegend';
import { ClockRing } from './ClockRing';
import { legendEntries } from './legend';
import { TomorrowPanel } from './TomorrowPanel';

/** At most this many all-day items are listed; the rest are counted. */
const MAX_ALL_DAY = 4;

function isTimeRow(row: QueryRow): row is ItemQueryRow {
  return 'kind' in row;
}

/**
 * The clock block: today on a 24-hour ring with a now-needle, a legend of the colours on it, a
 * "now / next" summary and the all-day items listed under it (never drawn). Every item is
 * coloured by its subject or topic and role (features/colours); its source is a small icon. Areas
 * are a band around the ring. The ring is a role="img" whose label is a live text summary of the
 * day; it never mirrors in right-to-left pages (ClockRing).
 */
export default function ClockBlock({ dashboard, block }: BlockComponentProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const locale = dateLocale(language);
  const { settings, topics } = useCurrentWorkspace();
  const timeZone = settings?.timezone ?? 'UTC';
  const now = useNow();
  const { vars } = usePageVars();
  const data = useBlockData(dashboard, block, vars);
  const showNext = block.viz['showNext'] !== false;
  /** Only an explicit true: a clock without the flag is today alone, as it always was. */
  const showTomorrow = block.viz['showTomorrow'] === true;

  const kept = useMemo(() => {
    const rows = (data.data?.rows ?? []).filter(isTimeRow);
    return applyDisplayRules(rows, block.rules, { now, timeZone, userId: '', vars })
      .filter((entry) => !entry.hidden)
      .map((entry) => entry.row);
  }, [data.data?.rows, block.rules, now, timeZone, vars]);
  const colourOf = useRowColours(kept);
  const model = useMemo(
    () => buildClockModel(kept, now, timeZone, colourOf, (row) => rowTitle(t, row)),
    [kept, now, timeZone, colourOf, t],
  );
  const tomorrowDay = useMemo(() => tomorrowOf(now, timeZone), [now, timeZone]);
  const tomorrow = useMemo(
    () =>
      showTomorrow
        ? buildClockModel(kept, now, timeZone, colourOf, (row) => rowTitle(t, row), tomorrowDay)
        : null,
    [showTomorrow, kept, now, timeZone, colourOf, t, tomorrowDay],
  );
  const topicNames = useMemo(
    () => new Map(topics.map((topic) => [topic.id, topic.name])),
    [topics],
  );
  /** What a colour stands for: its subject, else its topic, else Unsorted. */
  const labelOf = (colour: ItemColour): string =>
    colour.subject ??
    (colour.topicId === null ? undefined : topicNames.get(colour.topicId)) ??
    t('topics.unsorted');
  const legend = legendEntries([...model.timed, ...model.areas], labelOf);

  const time = (date: Date) => timeOfDay(date, locale, timeZone);
  const status = data.isLoading ? 'loading' : data.isError ? 'error' : 'ready';

  const { current, next } = model;
  const currentEnd =
    current === null ? null : (model.timed[model.timedOccurrences.indexOf(current)]?.end ?? null);
  const dayStatus =
    current !== null && currentEnd !== null
      ? t('timeBlocks.clock.nowEvent', { title: rowTitle(t, current.row), time: time(currentEnd) })
      : next !== null
        ? t('timeBlocks.clock.nextEvent', { title: rowTitle(t, next.row), time: time(next.start) })
        : t('timeBlocks.clock.nothingNext');
  const date = longDate(now, locale, timeZone);
  const summary =
    model.timed.length === 0
      ? t('timeBlocks.clock.summaryNone', { date })
      : t('timeBlocks.clock.summary', { count: model.timed.length, date, status: dayStatus });

  const labels = {
    summary,
    eventList: t('timeBlocks.clock.eventList'),
    describeEvent: (event: ClockEvent) => {
      const text = t('timeBlocks.clock.describeEvent', {
        title: event.title,
        start: time(event.start),
        end: time(event.end),
        topic: event.colour === undefined ? t('topics.unsorted') : labelOf(event.colour),
        source: t(sourceNameKey(event.source)),
      });
      const flags = [
        event.inactive === undefined || event.inactive === null
          ? null
          : t(inactiveKey(event.inactive)),
        event.leg?.conflict === true ? t('travel.leg.conflict') : null,
        event.leg?.unset === true ? t('travel.leg.setLength') : null,
      ].filter((flag) => flag !== null);
      return [text, ...flags].join('. ');
    },
    describeArea: (area: ClockArea) =>
      [
        t('timeBlocks.clock.describeArea', {
          title: area.title,
          start: time(area.start),
          end: time(area.end),
          topic: labelOf(area.colour),
        }),
        ...(area.inactive === undefined || area.inactive === null
          ? []
          : [t(inactiveKey(area.inactive))]),
      ].join('. '),
  };

  const todayColumn = (
    <div
      className={cn(
        'flex min-h-full flex-col items-center gap-3 pt-1',
        // Beside tomorrow's panel the column shares the row (and may shrink).
        showTomorrow && 'min-w-0 flex-1',
      )}
    >
      <div className="flex w-full min-w-0 flex-1 items-center justify-center">
        <ClockRing
          events={model.timed}
          areas={model.areas}
          now={now}
          timeZone={timeZone}
          labels={labels}
          className="w-full max-w-[260px]"
        />
      </div>
      {legend.entries.length === 0 ? null : (
        <ClockLegend entries={legend.entries} more={legend.more} />
      )}
      <div aria-live="polite" className="w-full min-w-0 space-y-1 text-[13px]">
        {model.timed.length === 0 ? (
          <p className="text-muted-foreground">{t('timeBlocks.clock.empty')}</p>
        ) : (
          <>
            <SummaryLine
              label={t('timeBlocks.clock.now')}
              occurrence={current}
              now={now}
              colourOf={colourOf}
              empty={t('timeBlocks.clock.nothingNow')}
              detail={
                currentEnd === null ? '' : t('timeBlocks.clock.until', { time: time(currentEnd) })
              }
            />
            {showNext ? (
              <SummaryLine
                label={t('timeBlocks.clock.next')}
                occurrence={next}
                now={now}
                colourOf={colourOf}
                empty={t('timeBlocks.clock.nothingNext')}
                detail={next === null ? '' : time(next.start)}
              />
            ) : null}
          </>
        )}
      </div>
      {model.allDay.length === 0 ? null : (
        <section aria-label={t('timeBlocks.clock.allDay')} className="w-full space-y-1">
          <h3 className="text-xs font-medium text-muted-foreground">
            {t('timeBlocks.clock.allDay')}
          </h3>
          <ul className="space-y-0.5">
            {model.allDay.slice(0, MAX_ALL_DAY).map((o) => (
              <li key={o.key} className="flex min-w-0 items-center gap-2 text-[13px]">
                <ColourDot colour={colourOf(o.row.id)} />
                <SourceIcon source={ringProvider(o.row.source.provider)} />
                <span
                  dir="auto"
                  title={o.row.title}
                  className={cn('min-w-0 flex-1 truncate', o.inactive !== null && INACTIVE_TITLE)}
                >
                  {o.row.title}
                </span>
                {o.inactive === null ? null : <InactiveTag inactive={o.inactive} />}
                <SourceLink
                  source={{ provider: o.row.source.provider, url: o.row.source.url }}
                  title={o.row.title}
                />
              </li>
            ))}
          </ul>
          {model.allDay.length > MAX_ALL_DAY ? (
            <p className="text-xs text-muted-foreground">
              {t('timeBlocks.clock.moreAllDay', { count: model.allDay.length - MAX_ALL_DAY })}
            </p>
          ) : null}
        </section>
      )}
    </div>
  );

  return (
    <BlockFrame
      title={blockTitle(block, t)}
      status={status}
      onRetry={() => {
        void data.refetch();
      }}
    >
      {tomorrow === null ? (
        todayColumn
      ) : (
        // A container, so "beside" is decided by the block's own width, not the screen's.
        <div className="@container min-h-full">
          <div className="flex min-h-full flex-col gap-5 @[32rem]:flex-row @[32rem]:items-start">
            {todayColumn}
            <TomorrowPanel
              model={tomorrow}
              day={tomorrowDay}
              timeZone={timeZone}
              date={longDate(tomorrowDay, locale, timeZone)}
              labelOf={labelOf}
              colourOf={colourOf}
              time={time}
              labels={{
                summary:
                  tomorrow.timed.length === 0
                    ? t('timeBlocks.clock.tomorrowSummaryNone', {
                        date: longDate(tomorrowDay, locale, timeZone),
                      })
                    : t('timeBlocks.clock.tomorrowSummary', {
                        count: tomorrow.timed.length,
                        date: longDate(tomorrowDay, locale, timeZone),
                      }),
                eventList: t('timeBlocks.clock.tomorrowEventList'),
                describeEvent: labels.describeEvent,
                describeArea: labels.describeArea,
              }}
            />
          </div>
        </div>
      )}
    </BlockFrame>
  );
}

function SummaryLine({
  label,
  occurrence,
  now,
  colourOf,
  empty,
  detail,
}: {
  label: string;
  occurrence: Occurrence | null;
  now: Date;
  colourOf: (rowId: string) => ItemColour;
  empty: string;
  detail: string;
}) {
  const { t } = useTranslation();
  const leg: LegMarks | null = occurrence === null ? null : legMarksOf(t, occurrence, now);
  const title = occurrence === null ? '' : (leg?.title ?? occurrence.row.title);
  return (
    <div
      data-clock-line=""
      data-conflict={leg === null ? undefined : String(leg.conflict)}
      data-past={leg === null ? undefined : String(leg.past)}
    >
      <p className="flex min-w-0 items-center gap-2">
        <span className="w-12 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
        {occurrence === null ? (
          <span className="text-muted-foreground">{empty}</span>
        ) : (
          <>
            <ColourDot colour={colourOf(occurrence.row.id)} />
            {leg === null ? (
              <SourceIcon source={ringProvider(occurrence.row.source.provider)} />
            ) : (
              <LegModeIcon mode={leg.mode} />
            )}
            <span dir="auto" title={title} className="min-w-0 flex-1 truncate">
              {title}
              {leg?.unset === true ? (
                <span className="sr-only">. {t('travel.leg.setLength')}</span>
              ) : null}
            </span>
            <span className="shrink-0 text-muted-foreground tabular-nums" dir="ltr">
              {detail}
            </span>
          </>
        )}
      </p>
      {leg?.conflict === true ? (
        <p className="ps-14 text-xs text-destructive">
          <ConflictMark />
        </p>
      ) : null}
    </div>
  );
}
