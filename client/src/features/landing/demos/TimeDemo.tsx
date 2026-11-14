import { useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { SourceLegend } from '@/components/items/SourceLegend';
import { SourceDot } from '@/components/items/SourceDot';
import { calendarDaysFrom, dateLocale, longDate, timeOfDay } from '@/components/items/format';
import { SOURCE_STYLES, sourceNameKey } from '@/components/items/sources';
import { ClockRing, type ClockEvent } from '@/features/dashboards/blocks/clock/ClockRing';
import { cn } from '@/lib/utils';
import { clockLabels, dayStatus } from '../clockLabels';
import { demoDayEvents, demoLanguage, demoWeekEvents } from '../demoData';
import { Block, BlockHeader } from '../layout';

interface DemoProps {
  now: Date;
  timeZone: string;
}

const FIRST_HOUR = 8;
const LAST_HOUR = 22;
const SPAN_MINUTES = (LAST_HOUR - FIRST_HOUR) * 60;
const GRID_HOURS = [12, 16, 20] as const;

function minutesIntoGrid(date: Date): number {
  return date.getHours() * 60 + date.getMinutes() - FIRST_HOUR * 60;
}

/** A week of events from 08:00 to 22:00, one column per day starting on Sunday. */
export function WeekGrid({
  events,
  now,
  timeZone,
  title,
  fadeIn = false,
}: DemoProps & {
  events: readonly ClockEvent[];
  /** The block's title; defaults to "This week". */
  title?: string | undefined;
  /** Events fade in when they mount, so a switch between two weeks reads as a change. */
  fadeIn?: boolean | undefined;
}) {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.language);
  const days = Array.from(
    { length: 7 },
    (_, index) => new Date(now.getFullYear(), now.getMonth(), now.getDate() - now.getDay() + index),
  );
  const weekday = new Intl.DateTimeFormat(locale, {
    weekday: locale.startsWith('he') ? 'narrow' : 'short',
  });
  const dayNumber = new Intl.DateTimeFormat(locale, { day: 'numeric' });
  const hourLabel = (hour: number) => String(hour).padStart(2, '0');
  const nowOffset = minutesIntoGrid(now) / SPAN_MINUTES;
  const describe = (event: ClockEvent) =>
    t('landing.week.event', {
      title: event.title,
      day: longDate(event.start, locale, timeZone),
      hours: t('landing.week.hours', {
        start: timeOfDay(event.start, locale, timeZone),
        end: timeOfDay(event.end, locale, timeZone),
      }),
      source: t(sourceNameKey(event.source)),
    });

  return (
    <Block className="flex flex-col">
      <BlockHeader title={title ?? t('landing.week.title')} />
      <div
        aria-hidden="true"
        className="grid flex-1 grid-cols-[1.75rem_repeat(7,minmax(0,1fr))] px-3 pb-4"
      >
        <span />
        {days.map((day) => {
          const isToday = calendarDaysFrom(now, day, timeZone) === 0;
          return (
            <div key={day.toDateString()} className="flex flex-col items-center gap-1 pb-2 text-xs">
              <span className="text-muted-foreground">{weekday.format(day)}</span>
              <span
                className={cn(
                  'flex size-6 items-center justify-center rounded-full tabular-nums',
                  isToday && 'bg-foreground font-semibold text-background',
                )}
              >
                {dayNumber.format(day)}
              </span>
            </div>
          );
        })}

        <div className="relative h-56 text-[11px] text-muted-foreground tabular-nums sm:h-64">
          <span className="absolute -top-1.5 start-0">{hourLabel(FIRST_HOUR)}</span>
          {GRID_HOURS.map((hour) => (
            <span
              key={hour}
              className="absolute start-0 -translate-y-1/2"
              style={{ top: `${String((((hour - FIRST_HOUR) * 60) / SPAN_MINUTES) * 100)}%` }}
            >
              {hourLabel(hour)}
            </span>
          ))}
        </div>
        {days.map((day) => {
          const isToday = calendarDaysFrom(now, day, timeZone) === 0;
          const dayEvents = events.filter(
            (event) => calendarDaysFrom(day, event.start, timeZone) === 0,
          );
          return (
            <div key={day.toDateString()} className="relative h-56 border-s border-t sm:h-64">
              {GRID_HOURS.map((hour) => (
                <span
                  key={hour}
                  className="absolute inset-x-0 h-px bg-border"
                  style={{ top: `${String((((hour - FIRST_HOUR) * 60) / SPAN_MINUTES) * 100)}%` }}
                />
              ))}
              {dayEvents.map((event) => {
                const top = Math.max(0, minutesIntoGrid(event.start) / SPAN_MINUTES);
                const bottom = Math.min(1, minutesIntoGrid(event.end) / SPAN_MINUTES);
                if (bottom <= top) {
                  return null;
                }
                return (
                  <span
                    key={event.id}
                    title={describe(event)}
                    className={cn(
                      'absolute inset-x-[3px] rounded-[3px] border-s-[3px]',
                      fadeIn && 'landing-fade',
                      SOURCE_STYLES[event.source].wash,
                      SOURCE_STYLES[event.source].edge,
                    )}
                    style={{
                      top: `${String(top * 100)}%`,
                      // The 2px surface gap between back-to-back events.
                      height: `calc(${String((bottom - top) * 100)}% - 2px)`,
                    }}
                  />
                );
              })}
              {isToday && nowOffset >= 0 && nowOffset <= 1 ? (
                <span
                  className="absolute -inset-x-px h-0.5 bg-foreground"
                  style={{ top: `${String(nowOffset * 100)}%` }}
                />
              ) : null}
            </div>
          );
        })}
      </div>
      <SourceLegend
        sources={events.map((event) => event.source)}
        label={t('landing.demo.legend')}
        className="border-t px-4 py-3"
      />
      <ul className="sr-only" aria-label={t('landing.week.eventList')}>
        {events.map((event) => (
          <li key={event.id}>{describe(event)}</li>
        ))}
      </ul>
    </Block>
  );
}

/** Today as the clock block and the week as a calendar block, side by side. */
export function TimeDemo({ now, timeZone }: DemoProps) {
  const { t, i18n } = useTranslation();
  const locale = dateLocale(i18n.language);
  const lang = demoLanguage(i18n.language);
  const dayEvents = useMemo(() => demoDayEvents(now, lang), [now, lang]);
  const weekEvents = useMemo(() => demoWeekEvents(now, lang), [now, lang]);
  const isToday = (date: Date) => calendarDaysFrom(now, date, timeZone) === 0;
  const labels = clockLabels(t, dayEvents, now, locale, timeZone, isToday);
  const { next } = dayStatus(dayEvents, now);

  return (
    <div className="grid grid-cols-1 gap-4 lg:grid-cols-12">
      <Block className="flex flex-col lg:col-span-4">
        <BlockHeader title={t('landing.demo.today')} aside={timeOfDay(now, locale, timeZone)} />
        <div className="flex flex-1 items-center justify-center px-4 py-2">
          <ClockRing events={dayEvents} now={now} timeZone={timeZone} size={232} labels={labels} />
        </div>
        {next ? (
          <p className="mx-4 flex min-h-11 items-center gap-2 border-t text-sm">
            <span className="w-12 shrink-0 text-[13px] text-muted-foreground">
              {t('landing.demo.next')}
            </span>
            <SourceDot source={next.source} />
            <span className="truncate">{next.title}</span>
            <span className="ms-auto shrink-0 text-[13px] text-muted-foreground tabular-nums">
              {isToday(next.start)
                ? timeOfDay(next.start, locale, timeZone)
                : t('landing.demo.tomorrowAt', { time: timeOfDay(next.start, locale, timeZone) })}
            </span>
          </p>
        ) : null}
      </Block>
      <div className="lg:col-span-8">
        <WeekGrid events={weekEvents} now={now} timeZone={timeZone} />
      </div>
    </div>
  );
}
