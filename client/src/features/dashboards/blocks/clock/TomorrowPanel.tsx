import { useTranslation } from 'react-i18next';
import { SourceIcon } from '@/components/items/SourceIcon';
import { ColourDot } from '@/features/colours/ColourDot';
import type { ItemColour } from '@api-types/colours';
import { cn } from '@/lib/utils';
import { INACTIVE_TITLE } from '../time/inactive';
import { InactiveTag } from '../time/InactiveTag';
import { ClockLegend } from './ClockLegend';
import { ClockRing, type ClockRingLabels } from './ClockRing';
import { ringProvider, type ClockModel } from './clockModel';
import { legendEntries } from './legend';

/** At most this many of tomorrow's items are listed; the rest are counted. */
const MAX_LISTED = 5;

/**
 * Tomorrow, beside (a wide block) or below (a narrow one) today's ring: a smaller ring without a
 * needle, its colour key, then the day's items in order (timed first, then all-day), so a late
 * look at the clock shows what is coming. Presentational: ClockBlock passes the model, the day's
 * anchor instant and every text. The ring never mirrors in right-to-left pages (ClockRing); the
 * list flows with the page.
 */
export function TomorrowPanel({
  model,
  day,
  timeZone,
  labels,
  date,
  labelOf,
  colourOf,
  time,
}: {
  model: ClockModel;
  /** Any instant of tomorrow (clockModel's `tomorrowOf`). */
  day: Date;
  timeZone: string;
  labels: ClockRingLabels;
  /** Tomorrow's date, long form, for the heading. */
  date: string;
  labelOf: (colour: ItemColour) => string;
  colourOf: (rowId: string) => ItemColour;
  time: (date: Date) => string;
}) {
  const { t } = useTranslation();
  const legend = legendEntries([...model.timed, ...model.areas], labelOf);
  const items = [
    ...model.timedOccurrences.map((o, index) => ({
      key: o.key,
      row: o.row,
      title: model.timed[index]?.title ?? o.row.title,
      when: time(o.start),
      inactive: o.inactive,
    })),
    ...model.allDay.map((o) => ({
      key: o.key,
      row: o.row,
      title: o.row.title,
      when: t('timeBlocks.clock.allDay'),
      inactive: o.inactive,
    })),
  ];
  return (
    <section
      data-clock-tomorrow=""
      aria-label={t('timeBlocks.clock.tomorrow')}
      className="flex min-w-0 flex-col items-center gap-3 pt-1 @[32rem]:w-[45%] @[32rem]:shrink-0"
    >
      <h3 className="w-full text-xs font-medium text-muted-foreground">
        {t('timeBlocks.clock.tomorrow')}
        <span className="ms-2 font-normal" dir="auto">
          {date}
        </span>
      </h3>
      <ClockRing
        events={model.timed}
        areas={model.areas}
        now={day}
        showNeedle={false}
        timeZone={timeZone}
        size={176}
        labels={labels}
        className="w-full max-w-[176px]"
      />
      {legend.entries.length === 0 ? null : (
        <ClockLegend entries={legend.entries} more={legend.more} />
      )}
      {items.length === 0 ? (
        <p className="w-full text-[13px] text-muted-foreground">
          {t('timeBlocks.clock.tomorrowEmpty')}
        </p>
      ) : (
        <ul className="w-full min-w-0 space-y-0.5">
          {items.slice(0, MAX_LISTED).map((item) => (
            <li key={item.key} className="flex min-w-0 items-center gap-2 text-[13px]">
              <ColourDot colour={colourOf(item.row.id)} />
              <SourceIcon source={ringProvider(item.row.source.provider)} />
              <span
                dir="auto"
                title={item.title}
                className={cn('min-w-0 flex-1 truncate', item.inactive !== null && INACTIVE_TITLE)}
              >
                {item.title}
              </span>
              {item.inactive === null ? null : <InactiveTag inactive={item.inactive} />}
              <span className="shrink-0 text-muted-foreground tabular-nums" dir="ltr">
                {item.when}
              </span>
            </li>
          ))}
          {items.length > MAX_LISTED ? (
            <li className="text-xs text-muted-foreground">
              {t('timeBlocks.clock.moreTomorrow', { count: items.length - MAX_LISTED })}
            </li>
          ) : null}
        </ul>
      )}
    </section>
  );
}
