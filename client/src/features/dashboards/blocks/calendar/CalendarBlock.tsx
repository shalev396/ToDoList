import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import listPlugin from '@fullcalendar/list';
import timeGridPlugin from '@fullcalendar/timegrid';
import heLocale from '@fullcalendar/core/locales/he';
import type { EventContentArg, EventMountArg } from '@fullcalendar/core';
import { CalendarClock, ChevronLeft, ChevronRight } from 'lucide-react';
import { useBlockData } from '@/api/queries/blocks';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { dateLocale, shortDate, timeOfDay } from '@/components/items/format';
import { sourceNameKey } from '@/components/items/sources';
import { SourceLink } from '@/features/items/SourceLink';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { useNow } from '@/hooks/useNow';
import { BlockFrame } from '../../BlockFrame';
import { blockTitle } from '../../chrome';
import { useGridBreakpoint } from '../../grid/useGridBreakpoint';
import type { ItemQueryRow, QueryRow } from '@api-types/builder';
import type { BlockComponentProps } from '../../registry/types';
import { applyDisplayRules } from '../../rules/applyDisplayRules';
import { usePageVars } from '../../variables/pageVars';
import { zonedParts, zonedTime } from '../clock/ClockRing.math';
import { ToneMark } from '../time/ToneMark';
import {
  expandOccurrences,
  visibleRange,
  wallDate,
  wallString,
  type WeekStart,
} from '../time/occurrences';
import { toEventInput, type CalendarEventProps, type DisplayedOccurrence } from './calendarEvents';
import { readStartHour, slotTime, startScrollTop } from './startHour';
import { useSaveCalendarViz } from './useSaveCalendarViz';

type View = 'week' | 'month';

const PLUGINS = [dayGridPlugin, timeGridPlugin, listPlugin];
const START_HOURS = Array.from({ length: 24 }, (_, hour) => {
  const label = `${String(hour).padStart(2, '0')}:00`;
  return { value: String(hour), label: <span dir="ltr">{label}</span> };
});
const EVENT_TIME = { hour: '2-digit', minute: '2-digit', hour12: false } as const;

/** FullCalendar's view for the choice: lists on a phone (a grid is too narrow to read). */
function fcView(view: View, phone: boolean, asList: boolean): string {
  if (view === 'month') {
    return phone ? 'listMonth' : 'dayGridMonth';
  }
  return phone || asList ? 'listWeek' : 'timeGridWeek';
}

/** Noon of `date`'s local day, so adding days never lands on the wrong side of midnight. */
function noonOf(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return zonedTime(p.year, p.month, p.day, 12, 0, timeZone);
}

function shift(anchor: Date, view: View, direction: -1 | 1, timeZone: string): Date {
  const p = zonedParts(anchor, timeZone);
  return view === 'month'
    ? zonedTime(p.year, p.month + direction, 1, 12, 0, timeZone)
    : zonedTime(p.year, p.month, p.day + direction * 7, 12, 0, timeZone);
}

function isTimeRow(row: QueryRow): row is ItemQueryRow {
  return 'kind' in row;
}

function readView(viz: Record<string, unknown>): { view: View; list: boolean; month: boolean } {
  const view = viz['view'];
  return {
    view: view === 'month' ? 'month' : 'week',
    list: view === 'list',
    month: viz['allowMonth'] !== false,
  };
}

/**
 * The calendar block (FullCalendar, MIT plugins only). Week is the default; Week or Month is
 * saved in the block's viz options for editors. Events are placed in the workspace's time zone
 * and coloured by source; a click opens the item Sheet (`?item=`). The series' cancelled
 * occurrences are excluded, never listed (occurrences.ts).
 */
export default function CalendarBlock({ dashboard, block, editing }: BlockComponentProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const locale = dateLocale(language);
  const { settings } = useCurrentWorkspace();
  const timeZone = settings?.timezone ?? 'UTC';
  const weekStart: WeekStart = settings?.weekStart ?? 'sun';
  const now = useNow();
  const phone = useGridBreakpoint() === 'sm';
  const [, setSearchParams] = useSearchParams();
  const { vars } = usePageVars();

  const options = readView(block.viz);
  const [view, setView] = useState<View>(options.view);
  const [anchor, setAnchor] = useState(() => noonOf(new Date(), timeZone));
  const range = useMemo(
    () => visibleRange(view, anchor, timeZone, weekStart),
    [view, anchor, timeZone, weekStart],
  );
  const rangeVar = useMemo(
    () => ({ from: range.from.toISOString(), to: range.to.toISOString() }),
    [range],
  );
  const data = useBlockData(dashboard, block, { ...vars, range: rangeVar });
  const save = useSaveCalendarViz(dashboard, block);
  const [startHour, setStartHour] = useState(() => readStartHour(block.viz));
  const region = useRef<HTMLDivElement>(null);

  const displayed = useMemo<DisplayedOccurrence[]>(() => {
    const rows = (data.data?.rows ?? []).filter(isTimeRow);
    const shown = applyDisplayRules(rows, block.rules, { now, timeZone, userId: '', vars });
    const visible = shown.filter((entry) => !entry.hidden);
    const byRow = new Map(visible.map((entry) => [entry.row.id, entry] as const));
    return expandOccurrences(
      visible.map((entry) => entry.row),
      range,
      timeZone,
    ).map((occurrence) => {
      const entry = byRow.get(occurrence.row.id);
      return { occurrence, tone: entry?.tone, badges: entry?.badges ?? [] };
    });
  }, [data.data?.rows, block.rules, now, timeZone, vars, range]);
  const events = useMemo(
    () => displayed.map((item) => toEventInput(item, timeZone)),
    [displayed, timeZone],
  );

  const calendar = useRef<FullCalendar>(null);
  const viewName = fcView(view, phone, options.list);
  useEffect(() => {
    calendar.current?.getApi().changeView(viewName, wallDate(anchor, timeZone));
  }, [viewName, anchor, timeZone]);

  // Scrolls the week grid so the start hour's row sits under the day header; measured from the
  // rendered row. Only the week grid has hours to scroll to (month and lists skip it).
  const scrollToStart = useCallback(() => {
    const box = region.current;
    if (box === null || calendar.current?.getApi().view.type !== 'timeGridWeek') {
      return;
    }
    const slot = box.querySelector(`.fc-timegrid-slot-lane[data-time="${slotTime(startHour)}"]`);
    if (slot === null) {
      return;
    }
    const sticky = box.querySelector('.fc-scrollgrid-section-header');
    box.scrollTop = startScrollTop({
      hour: startHour,
      slotTop: slot.getBoundingClientRect().top,
      regionTop: box.getBoundingClientRect().top,
      scrollTop: box.scrollTop,
      stickyHeight: sticky?.getBoundingClientRect().height ?? 0,
    });
  }, [startHour]);
  const scrollSoon = useCallback(() => {
    requestAnimationFrame(scrollToStart);
  }, [scrollToStart]);
  useEffect(scrollSoon, [scrollSoon]);

  const choose = (next: string) => {
    if ((next !== 'week' && next !== 'month') || next === view) {
      return;
    }
    setView(next);
    save({ view: next });
  };
  // A new history entry, so the back button closes the Sheet.
  const openItem = (id: string) => {
    setSearchParams((current) => {
      const next = new URLSearchParams(current);
      next.set('item', id);
      return next;
    });
  };

  const title = useMemo(() => {
    const month = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone });
    if (view === 'month') {
      return month.format(anchor);
    }
    const last = new Date(range.to.getTime() - 12 * 3600_000);
    return `${shortDate(range.from, locale, timeZone)} – ${shortDate(last, locale, timeZone)}`;
  }, [view, anchor, range, locale, timeZone]);

  const renderEvent = (arg: EventContentArg) => {
    const props = arg.event.extendedProps as CalendarEventProps;
    return (
      <div className="flex min-w-0 items-center gap-1 px-1 text-[11px] leading-4">
        {props.dueOnly ? (
          <CalendarClock aria-hidden="true" className="size-3 shrink-0" data-due-marker />
        ) : null}
        {props.tone === undefined ? null : <ToneMark tone={props.tone} />}
        {arg.timeText === '' || arg.event.allDay ? null : (
          <span className="shrink-0 font-medium tabular-nums">{arg.timeText}</span>
        )}
        <span dir="auto" className="min-w-0 truncate">
          {arg.event.title}
        </span>
        {props.badges.map((badge) => (
          <span key={badge} className="shrink-0 rounded-sm bg-sunken px-1 text-[10px]">
            {badge}
          </span>
        ))}
      </div>
    );
  };

  const describe = (arg: EventMountArg) => {
    const props = arg.event.extendedProps as CalendarEventProps;
    const start = arg.event.start;
    // The event's dates are the workspace's wall clock read as UTC.
    const when = arg.event.allDay
      ? t('timeBlocks.calendar.allDay')
      : start === null
        ? ''
        : timeOfDay(start, locale, 'UTC');
    const source = t(sourceNameKey(props.provider as never));
    arg.el.setAttribute(
      'aria-label',
      t(props.dueOnly ? 'timeBlocks.calendar.dueLabel' : 'timeBlocks.calendar.eventLabel', {
        title: arg.event.title,
        when,
        source,
      }),
    );
    arg.el.setAttribute('data-item-id', props.rowId);
  };

  const status = data.isLoading ? 'loading' : data.isError ? 'error' : 'ready';
  const rangeText = `${shortDate(range.from, locale, timeZone)} – ${shortDate(
    new Date(range.to.getTime() - 12 * 3600_000),
    locale,
    timeZone,
  )}`;

  return (
    <BlockFrame
      title={blockTitle(block, t)}
      status={status}
      onRetry={() => {
        void data.refetch();
      }}
      actions={
        editing ? undefined : (
          <>
            {view === 'week' && !phone && !options.list ? (
              <SelectField
                aria-label={t('timeBlocks.calendar.startsAt')}
                value={String(startHour)}
                options={START_HOURS}
                onValueChange={(next) => {
                  const hour = Number(next);
                  setStartHour(hour);
                  save({ startHour: hour });
                }}
                triggerClassName="h-7 min-h-7 w-auto gap-1 pointer-coarse:h-11 pointer-coarse:min-h-11"
              />
            ) : null}
            {options.month ? (
              <ToggleGroup
                type="single"
                value={view}
                onValueChange={choose}
                aria-label={t('timeBlocks.calendar.viewLabel')}
              >
                <ToggleGroupItem value="week">{t('timeBlocks.calendar.week')}</ToggleGroupItem>
                <ToggleGroupItem value="month">{t('timeBlocks.calendar.month')}</ToggleGroupItem>
              </ToggleGroup>
            ) : null}
          </>
        )
      }
    >
      <div className="flex h-full min-h-72 flex-col gap-2" data-calendar-view={view}>
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('timeBlocks.calendar.previous')}
            onClick={() => {
              setAnchor((current) => shift(current, view, -1, timeZone));
            }}
          >
            <ChevronLeft aria-hidden="true" className="rtl:rotate-180" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            aria-label={t('timeBlocks.calendar.next')}
            onClick={() => {
              setAnchor((current) => shift(current, view, 1, timeZone));
            }}
          >
            <ChevronRight aria-hidden="true" className="rtl:rotate-180" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => {
              setAnchor(noonOf(new Date(), timeZone));
            }}
          >
            {t('timeBlocks.calendar.today')}
          </Button>
          <p
            aria-live="polite"
            className="min-w-0 flex-1 truncate text-end text-[13px] font-medium"
            data-calendar-title
          >
            {title}
          </p>
        </div>
        {displayed.length === 0 && data.data !== undefined ? (
          <p className="shrink-0 text-[13px] text-muted-foreground">
            {t('timeBlocks.calendar.empty', { range: rangeText })}
          </p>
        ) : null}
        <div
          ref={region}
          role="region"
          tabIndex={0}
          data-start-hour={startHour}
          aria-label={t('timeBlocks.calendar.scrollRegion')}
          className="todolist-calendar min-h-0 flex-1 overflow-auto focus-visible:ring-2 focus-visible:ring-ring"
          dir={language === 'he' ? 'rtl' : 'ltr'}
        >
          <FullCalendar
            ref={calendar}
            plugins={PLUGINS}
            initialView={viewName}
            initialDate={wallDate(anchor, timeZone)}
            timeZone="UTC"
            now={wallString(now, timeZone)}
            nowIndicator
            headerToolbar={false}
            locales={[heLocale]}
            locale={language === 'he' ? 'he' : 'en'}
            direction={language === 'he' ? 'rtl' : 'ltr'}
            firstDay={weekStart === 'sun' ? 0 : 1}
            height="auto"
            expandRows
            allDaySlot
            allDayText={t('timeBlocks.calendar.allDay')}
            slotDuration="00:30:00"
            viewDidMount={scrollSoon}
            datesSet={scrollSoon}
            defaultTimedEventDuration="00:30:00"
            eventTimeFormat={EVENT_TIME}
            slotLabelFormat={EVENT_TIME}
            dayMaxEvents
            eventInteractive
            displayEventEnd={false}
            events={events}
            eventContent={renderEvent}
            eventDidMount={describe}
            eventClick={(arg) => {
              arg.jsEvent.preventDefault();
              const props = arg.event.extendedProps as CalendarEventProps;
              openItem(props.rowId);
            }}
            noEventsContent={() => null}
          />
        </div>
        <SourceCount occurrences={displayed} />
      </div>
    </BlockFrame>
  );
}

/** A row without a source URL is a data error (blocks' source-link rule), said once, quietly. */
function SourceCount({ occurrences }: { occurrences: readonly DisplayedOccurrence[] }) {
  const missing = occurrences.find((item) => item.occurrence.row.source.url === '');
  if (missing === undefined) {
    return null;
  }
  return (
    <div className="shrink-0 text-[13px]">
      <SourceLink
        source={{
          provider: missing.occurrence.row.source.provider,
          url: missing.occurrence.row.source.url,
        }}
        title={missing.occurrence.row.title}
        variant="label"
      />
    </div>
  );
}
