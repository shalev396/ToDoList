import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { useBlockData } from '@/api/queries/blocks';
import { dateLocale, longDate, timeOfDay } from '@/components/items/format';
import { SourceDot } from '@/components/items/SourceDot';
import { sourceNameKey } from '@/components/items/sources';
import { SourceLink } from '@/features/items/SourceLink';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { useNow } from '@/hooks/useNow';
import { BlockFrame } from '../../BlockFrame';
import { blockTitle } from '../../chrome';
import type { BlockComponentProps } from '../../registry/types';
import { applyDisplayRules } from '../../rules/applyDisplayRules';
import { usePageVars } from '../../variables/pageVars';
import type { ItemQueryRow, QueryRow } from '@api-types/builder';
import type { Occurrence } from '../time/occurrences';
import { buildClockModel, ringProvider, type ClockEvent } from './clockModel';
import { ClockRing } from './ClockRing';

/** At most this many all-day items are listed; the rest are counted. */
const MAX_ALL_DAY = 4;

function isTimeRow(row: QueryRow): row is ItemQueryRow {
  return 'kind' in row;
}

/**
 * The clock block: today on a 24-hour ring with a now-needle, a "now / next" summary and the
 * all-day items listed under it (never drawn). The ring is a role="img" whose label is a live text
 * summary of the day; it never mirrors in right-to-left pages (ClockRing).
 */
export default function ClockBlock({ dashboard, block }: BlockComponentProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const locale = dateLocale(language);
  const { settings } = useCurrentWorkspace();
  const timeZone = settings?.timezone ?? 'UTC';
  const now = useNow();
  const { vars } = usePageVars();
  const data = useBlockData(dashboard, block, vars);
  const showNext = block.viz['showNext'] !== false;

  const model = useMemo(() => {
    const rows = (data.data?.rows ?? []).filter(isTimeRow);
    const kept = applyDisplayRules(rows, block.rules, { now, timeZone, userId: '', vars })
      .filter((entry) => !entry.hidden)
      .map((entry) => entry.row);
    return buildClockModel(kept, now, timeZone);
  }, [data.data?.rows, block.rules, now, timeZone, vars]);

  const time = (date: Date) => timeOfDay(date, locale, timeZone);
  const status = data.isLoading ? 'loading' : data.isError ? 'error' : 'ready';

  const { current, next } = model;
  const currentEnd =
    current === null ? null : (model.timed[model.timedOccurrences.indexOf(current)]?.end ?? null);
  const dayStatus =
    current !== null && currentEnd !== null
      ? t('timeBlocks.clock.nowEvent', { title: current.row.title, time: time(currentEnd) })
      : next !== null
        ? t('timeBlocks.clock.nextEvent', { title: next.row.title, time: time(next.start) })
        : t('timeBlocks.clock.nothingNext');
  const date = longDate(now, locale, timeZone);
  const summary =
    model.timed.length === 0
      ? t('timeBlocks.clock.summaryNone', { date })
      : t('timeBlocks.clock.summary', { count: model.timed.length, date, status: dayStatus });

  const labels = {
    summary,
    eventList: t('timeBlocks.clock.eventList'),
    describeEvent: (event: ClockEvent) =>
      t('timeBlocks.clock.describeEvent', {
        title: event.title,
        start: time(event.start),
        end: time(event.end),
        source: t(sourceNameKey(event.source)),
      }),
  };

  return (
    <BlockFrame
      title={blockTitle(block, t)}
      status={status}
      onRetry={() => {
        void data.refetch();
      }}
    >
      <div className="flex min-h-full flex-col items-center gap-3 pt-1">
        <div className="flex w-full min-w-0 flex-1 items-center justify-center">
          <ClockRing
            events={model.timed}
            now={now}
            timeZone={timeZone}
            labels={labels}
            className="w-full max-w-[260px]"
          />
        </div>
        <div aria-live="polite" className="w-full min-w-0 space-y-1 text-[13px]">
          {model.timed.length === 0 ? (
            <p className="text-muted-foreground">{t('timeBlocks.clock.empty')}</p>
          ) : (
            <>
              <SummaryLine
                label={t('timeBlocks.clock.now')}
                occurrence={current}
                empty={t('timeBlocks.clock.nothingNow')}
                detail={
                  currentEnd === null ? '' : t('timeBlocks.clock.until', { time: time(currentEnd) })
                }
              />
              {showNext ? (
                <SummaryLine
                  label={t('timeBlocks.clock.next')}
                  occurrence={next}
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
                  <SourceDot source={ringProvider(o.row.source.provider)} />
                  <span dir="auto" title={o.row.title} className="min-w-0 flex-1 truncate">
                    {o.row.title}
                  </span>
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
    </BlockFrame>
  );
}

function SummaryLine({
  label,
  occurrence,
  empty,
  detail,
}: {
  label: string;
  occurrence: Occurrence | null;
  empty: string;
  detail: string;
}) {
  return (
    <p className="flex min-w-0 items-center gap-2">
      <span className="w-12 shrink-0 text-xs font-medium text-muted-foreground">{label}</span>
      {occurrence === null ? (
        <span className="text-muted-foreground">{empty}</span>
      ) : (
        <>
          <SourceDot source={ringProvider(occurrence.row.source.provider)} />
          <span dir="auto" title={occurrence.row.title} className="min-w-0 flex-1 truncate">
            {occurrence.row.title}
          </span>
          <span className="shrink-0 text-muted-foreground tabular-nums" dir="ltr">
            {detail}
          </span>
        </>
      )}
    </p>
  );
}
