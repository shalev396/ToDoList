import { lazy } from 'react';
import { CalendarCheck, CalendarDays, Clock, Gauge, GanttChart } from 'lucide-react';
import type { BlockRegistryPart } from './types';

/**
 * Time blocks: calendar and clock (plan T4.7, agent group B). Both refetch every minute
 * (FRONTEND.md §6).
 */
const CalendarBlock = lazy(() => import('../blocks/calendar/CalendarBlock'));
const ClockBlock = lazy(() => import('../blocks/clock/ClockBlock'));
const AgendaBlock = lazy(() => import('../blocks/agenda/AgendaBlock'));
const TimelineBlock = lazy(() => import('../blocks/timeline/TimelineBlock'));
const WorkloadBlock = lazy(() => import('../blocks/workload/WorkloadBlock'));

/** The clock's and the calendar's refresh (FRONTEND.md §6 "Freshness"). */
const EVERY_MINUTE_MS = 60_000;

export const timeBlocks: BlockRegistryPart<
  'calendar' | 'clock' | 'agenda' | 'timeline' | 'workload'
> = {
  calendar: {
    component: CalendarBlock,
    icon: CalendarDays,
    defaultSize: { w: 8, h: 10 },
    minSize: { w: 4, h: 6 },
    refetchIntervalMs: EVERY_MINUTE_MS,
  },
  clock: {
    component: ClockBlock,
    icon: Clock,
    defaultSize: { w: 4, h: 8 },
    minSize: { w: 3, h: 6 },
    refetchIntervalMs: EVERY_MINUTE_MS,
  },
  agenda: {
    component: AgendaBlock,
    icon: CalendarCheck,
    defaultSize: { w: 6, h: 10 },
    minSize: { w: 3, h: 6 },
    refetchIntervalMs: EVERY_MINUTE_MS,
  },
  timeline: {
    component: TimelineBlock,
    icon: GanttChart,
    defaultSize: { w: 8, h: 10 },
    minSize: { w: 4, h: 6 },
    refetchIntervalMs: EVERY_MINUTE_MS,
  },
  workload: {
    component: WorkloadBlock,
    icon: Gauge,
    defaultSize: { w: 8, h: 8 },
    minSize: { w: 4, h: 6 },
    refetchIntervalMs: EVERY_MINUTE_MS,
  },
};
