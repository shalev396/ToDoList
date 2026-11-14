import type { TFunction } from 'i18next';
import { sourceNameKey } from '@/components/items/sources';
import { timeOfDay } from '@/components/items/format';
import type { ClockEvent, ClockRingLabels } from '@/features/dashboards/blocks/clock/ClockRing';

export interface DayStatus {
  /** The event happening now, if any. */
  current: ClockEvent | undefined;
  /** The next event to start after now, today or later. */
  next: ClockEvent | undefined;
}

/** What is on now and what starts next, from events sorted or not. */
export function dayStatus(events: readonly ClockEvent[], now: Date): DayStatus {
  const time = now.getTime();
  const sorted = [...events].sort((a, b) => a.start.getTime() - b.start.getTime());
  return {
    current: sorted.find((e) => e.start.getTime() <= time && e.end.getTime() > time),
    next: sorted.find((e) => e.start.getTime() > time),
  };
}

/** Accessible text for a ClockRing on the landing page. */
export function clockLabels(
  t: TFunction,
  events: readonly ClockEvent[],
  now: Date,
  locale: string,
  timeZone: string,
  isToday: (date: Date) => boolean,
): ClockRingLabels {
  const time = (date: Date) => timeOfDay(date, locale, timeZone);
  const { current, next } = dayStatus(events, now);
  let status = t('landing.demo.statusNone');
  if (current) {
    status = t('landing.demo.statusNow', { title: current.title, time: time(current.end) });
  } else if (next) {
    status = isToday(next.start)
      ? t('landing.demo.statusNext', { title: next.title, time: time(next.start) })
      : t('landing.demo.statusTomorrow', { title: next.title, time: time(next.start) });
  }
  const todayCount = events.filter((e) => isToday(e.start) || isToday(e.end)).length;
  return {
    summary: t('landing.demo.clockSummary', { count: todayCount, time: time(now), status }),
    eventList: t('landing.demo.eventList'),
    describeEvent: (event) =>
      t('landing.demo.event', {
        title: event.title,
        start: time(event.start),
        end: time(event.end),
        source: t(sourceNameKey(event.source)),
      }),
  };
}
