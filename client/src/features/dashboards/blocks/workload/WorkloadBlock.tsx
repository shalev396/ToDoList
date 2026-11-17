import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { Gauge } from 'lucide-react';
import { dateLocale } from '@/components/items/format';
import { useItemParam } from '@/features/items/useItemParam';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import { BlockFrame } from '../../BlockFrame';
import { blockTitle } from '../../chrome';
import type { BlockComponentProps } from '../../registry/types';
import { truncateText } from '../data/truncate';
import { useDataBlock } from '../data/useDataBlock';
import { buildWorkload } from './workloadModel';

const DEFAULT_CAPACITY_HOURS = 8;

function capacityOf(viz: Record<string, unknown>): number {
  const value = viz['capacityHours'];
  return typeof value === 'number' && value >= 1 ? value : DEFAULT_CAPACITY_HOURS;
}

/**
 * The workload (H3): hours per day over the week, from calendar events and task estimates (a story
 * point is 4 hours). A day over the capacity is marked; tasks with no estimate count as nothing and
 * are listed, so a light-looking day is never a silent guess.
 */
export default function WorkloadBlock({ dashboard, block }: BlockComponentProps) {
  const { t, i18n } = useTranslation();
  const { language } = useLanguage();
  const { openItem } = useItemParam();
  const { query, rows, loadState, now, timeZone, weekStart } = useDataBlock(dashboard, block);
  const title = blockTitle(block, t);
  const capacity = capacityOf(block.viz);
  const locale = dateLocale(language);
  const model = useMemo(
    () =>
      buildWorkload(
        rows.map((entry) => entry.row),
        now,
        timeZone,
        weekStart ?? 'sun',
        capacity,
      ),
    [rows, now, timeZone, weekStart, capacity],
  );
  const scale = Math.max(model.peakHours, capacity);
  const hours = (value: number): string =>
    t('timeBlocks.workload.hours', { value: new Intl.NumberFormat(locale).format(value) });
  const day = new Intl.DateTimeFormat(locale, { weekday: 'short', day: 'numeric', timeZone });
  const status =
    loadState !== 'ready'
      ? loadState
      : model.totalHours === 0 && model.unestimated.length === 0
        ? 'empty'
        : 'ready';
  return (
    <BlockFrame
      title={title}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<Gauge />}
      emptyMessage={t('timeBlocks.workload.empty')}
    >
      <div data-workload className="flex flex-col gap-4" dir={i18n.dir()}>
        <p className="text-[13px] text-muted-foreground">
          {t('timeBlocks.workload.summary', {
            total: new Intl.NumberFormat(locale).format(model.totalHours),
            capacity: new Intl.NumberFormat(locale).format(capacity),
          })}
        </p>
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {model.days.map((entry) => (
            <li
              key={entry.date}
              data-workload-day={entry.date}
              data-over={entry.over ? 'true' : undefined}
              className="grid grid-cols-[5.5rem_1fr_4rem] items-center gap-2 text-sm"
            >
              <span className="text-muted-foreground">{day.format(entry.start)}</span>
              <span
                role="img"
                aria-label={t('timeBlocks.workload.dayLabel', {
                  events: hours(entry.eventHours),
                  tasks: hours(entry.taskHours),
                })}
                className="flex h-3 overflow-hidden rounded-full bg-sunken"
              >
                <span
                  className="h-full bg-foreground/70"
                  style={{ width: `${String((entry.eventHours / scale) * 100)}%` }}
                />
                <span
                  className={cn('h-full', entry.over ? 'bg-destructive' : 'bg-foreground/35')}
                  style={{ width: `${String((entry.taskHours / scale) * 100)}%` }}
                />
              </span>
              <span className={cn('text-end tabular-nums', entry.over && 'text-destructive')}>
                {hours(entry.totalHours)}
                {entry.over ? (
                  <span className="sr-only"> {t('timeBlocks.workload.over')}</span>
                ) : null}
              </span>
            </li>
          ))}
        </ul>
        <p className="flex flex-wrap items-center gap-x-4 gap-y-1 text-xs text-muted-foreground">
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-foreground/70" />
            {t('timeBlocks.workload.events')}
          </span>
          <span className="inline-flex items-center gap-1.5">
            <span aria-hidden="true" className="size-2 rounded-full bg-foreground/35" />
            {t('timeBlocks.workload.tasks')}
          </span>
        </p>
        {model.unestimated.length === 0 ? null : (
          <section data-workload-unestimated aria-label={t('timeBlocks.workload.unestimated')}>
            <h3 className="text-xs font-semibold tracking-wide text-muted-foreground uppercase">
              {t('timeBlocks.workload.unestimatedCount', { count: model.unestimated.length })}
            </h3>
            <p className="pb-1 text-[13px] text-muted-foreground">
              {t('timeBlocks.workload.unestimatedHint')}
            </p>
            <ul className="m-0 list-none p-0">
              {model.unestimated.map((row) => (
                <li key={row.id} className="border-b last:border-b-0">
                  <button
                    type="button"
                    onClick={() => {
                      openItem(row.id);
                    }}
                    className="min-h-11 w-full truncate rounded-sm text-start text-sm hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                    dir="auto"
                  >
                    {truncateText(row.title, 160) || t('dataBlocks.noTitle')}
                  </button>
                </li>
              ))}
            </ul>
          </section>
        )}
      </div>
    </BlockFrame>
  );
}
