import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import FullCalendar from '@fullcalendar/react';
import dayGridPlugin from '@fullcalendar/daygrid';
import interactionPlugin from '@fullcalendar/interaction';
import listPlugin from '@fullcalendar/list';
import timeGridPlugin from '@fullcalendar/timegrid';
import heLocale from '@fullcalendar/core/locales/he';
import type {
  DateSelectArg,
  DateSpanApi,
  EventContentArg,
  EventMountArg,
} from '@fullcalendar/core';
import { CalendarClock, ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useBlockData } from '@/api/queries/blocks';
import { Button } from '@/components/ui/button';
import { SelectField } from '@/components/ui/select';
import { ToggleGroup, ToggleGroupItem } from '@/components/ui/toggle-group';
import { dateLocale, shortDate, timeOfDay } from '@/components/items/format';
import { SourceIcon } from '@/components/items/SourceIcon';
import { sourceNameKey } from '@/components/items/sources';
import { colourVar, hatchBackground, paintOf } from '@/features/colours/palette';
import { useRowColours } from '@/features/colours/useColours';
import { SourceLink } from '@/features/items/SourceLink';
import { presetFromSelection } from '@/features/items/scheduled/dragPreset';
import { useItemParam } from '@/features/items/useItemParam';
import { ConflictMark, LegModeIcon } from '@/features/travel/LegMark';
import { legMarksOf } from '@/features/travel/legView';
import { useShellUi } from '@/features/shell/shellUi';
import { cn } from '@/lib/utils';
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
import { ringProvider } from '../clock/clockModel';
import { splitAreas } from '../time/areas';
import { ToneMark } from '../time/ToneMark';
import {
  expandOccurrences,
  visibleRange,
  wallDate,
  wallString,
  type WeekStart,
} from '../time/occurrences';
import {
  toAreaEventInput,
  toAreaPeriodEventInput,
  toEventInput,
  type CalendarAreaProps,
  type CalendarEventProps,
  type DisplayedOccurrence,
} from './calendarEvents';
import { readStartHour, slotTime, startScrollTop } from './startHour';
import { useSaveCalendarViz } from './useSaveCalendarViz';

type View = 'week' | 'month';

// The interaction plugin makes the week grid selectable (a drag across free time); events stay
// put (`editable` is off).
const PLUGINS = [dayGridPlugin, timeGridPlugin, listPlugin, interactionPlugin];
const START_HOURS = Array.from({ length: 24 }, (_, hour) => {
  const label = `${String(hour).padStart(2, '0')}:00`;
  return { value: String(hour), label: <span dir="ltr">{label}</span> };
});
const EVENT_TIME = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
/** The longest span a drag makes a block of: a block lasts at most a day. */
const LONGEST_DRAG_MS = 24 * 3600_000;

/** FullCalendar's `UTC` dates hold the workspace's wall clock: `2026-11-22T13:00:00`. */
const wallOf = (date: Date): string => date.toISOString().slice(0, 19);

/** A drag on the week grid's hours (not the all-day row), a day at most, makes a block. */
function blockSpanAllowed(span: DateSpanApi): boolean {
  return !span.allDay && span.end.getTime() - span.start.getTime() <= LONGEST_DRAG_MS;
}

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
 * and coloured by subject or topic and role (features/colours), with their source as a small
 * icon; travel is hatched, its label on a plate of its fill. Areas are bands in their tint behind
 * everything, labelled at the top. A click opens the item Sheet (`?item=`), on the occurrence
 * clicked (`?occurrence=`). The series' cancelled occurrences are excluded, never listed
 * (occurrences.ts).
 *
 * Editors drag across free time on the week grid (not on a phone, where it is a list) to open
 * the New sheet on a time block at that time; inside an area it starts on the area's page
 * (dragPreset.ts). "New time block" in the toolbar does the same from the keyboard, or on a phone.
 */
export default function CalendarBlock({ dashboard, block, editing }: BlockComponentProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const locale = dateLocale(language);
  const { settings, role } = useCurrentWorkspace();
  const canWrite = role === 'editor' || role === 'owner';
  const { openItem } = useItemParam();
  const { openNewItem } = useShellUi();
  const timeZone = settings?.timezone ?? 'UTC';
  const weekStart: WeekStart = settings?.weekStart ?? 'sun';
  const now = useNow();
  const phone = useGridBreakpoint() === 'sm';
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

  const visible = useMemo(() => {
    const rows = (data.data?.rows ?? []).filter(isTimeRow);
    const shown = applyDisplayRules(rows, block.rules, { now, timeZone, userId: '', vars });
    return shown.filter((entry) => !entry.hidden);
  }, [data.data?.rows, block.rules, now, timeZone, vars]);
  const visibleRows = useMemo(() => visible.map((entry) => entry.row), [visible]);
  const colourOf = useRowColours(visibleRows);
  const { areas, displayed } = useMemo(() => {
    const byRow = new Map(visible.map((entry) => [entry.row.id, entry] as const));
    const split = splitAreas(expandOccurrences(visibleRows, range, timeZone), colourOf);
    return {
      areas: split.areas,
      displayed: split.items.map((occurrence): DisplayedOccurrence => {
        const entry = byRow.get(occurrence.row.id);
        return {
          occurrence,
          tone: entry?.tone,
          badges: entry?.badges ?? [],
          leg: legMarksOf(t, occurrence, now) ?? undefined,
        };
      }),
    };
  }, [visible, visibleRows, range, timeZone, colourOf, t, now]);
  const viewName = fcView(view, phone, options.list);
  // FullCalendar draws no background events in the month grid or a list: there an area is a
  // plain event, in the area's style, that opens its sheet.
  const areasAsEvents = viewName !== 'timeGridWeek';
  const events = useMemo(
    () => [
      ...areas.map((occurrence) =>
        (areasAsEvents ? toAreaPeriodEventInput : toAreaEventInput)(
          occurrence,
          colourOf(occurrence.row.id),
          timeZone,
        ),
      ),
      ...displayed.map((item) => toEventInput(item, timeZone, colourOf(item.occurrence.row.id))),
    ],
    [areas, areasAsEvents, displayed, timeZone, colourOf],
  );

  const calendar = useRef<FullCalendar>(null);
  useEffect(() => {
    // After the commit: a click's effects run inside it, and FullCalendar renders a new date
    // with flushSync, which React refuses there ("flushSync was called from inside a lifecycle").
    let live = true;
    queueMicrotask(() => {
      if (live) {
        calendar.current?.getApi().changeView(viewName, wallDate(anchor, timeZone));
      }
    });
    return () => {
      live = false;
    };
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
  // Everything the grid shows, areas included: a drag inside an area takes its page.
  const shown = useMemo(
    () => [...areas, ...displayed.map((item) => item.occurrence)],
    [areas, displayed],
  );
  const selectable = canWrite && !editing && viewName === 'timeGridWeek';
  const createFromSelection = (arg: DateSelectArg) => {
    arg.view.calendar.unselect();
    openNewItem(
      presetFromSelection(
        { startWall: wallOf(arg.start), endWall: wallOf(arg.end) },
        shown,
        timeZone,
      ),
    );
  };

  const title = useMemo(() => {
    const month = new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone });
    if (view === 'month') {
      return month.format(anchor);
    }
    const last = new Date(range.to.getTime() - 12 * 3600_000);
    return `${shortDate(range.from, locale, timeZone)} – ${shortDate(last, locale, timeZone)}`;
  }, [view, anchor, range, locale, timeZone]);

  /** The event's time as the workspace's wall clock (FullCalendar reads it as UTC). */
  const wallTime = (date: Date | null) => (date === null ? '' : timeOfDay(date, locale, 'UTC'));

  const renderEvent = (arg: EventContentArg) => {
    // The span being dragged across (`selectMirror`): its times, nothing else yet.
    if (arg.isMirror) {
      return (
        <div
          className="px-1 text-[11px] leading-4 font-medium text-primary-foreground tabular-nums"
          data-select-mirror=""
          dir="ltr"
        >
          {wallTime(arg.event.start)}–{wallTime(arg.event.end)}
        </div>
      );
    }
    const props = arg.event.extendedProps as CalendarEventProps | CalendarAreaProps;
    if ('area' in props && arg.event.display !== 'background') {
      // A list or month row: the area's title in its tint, like any event.
      return (
        <div className="flex min-w-0 items-center gap-1 px-1 text-[11px] leading-4">
          {arg.timeText === '' || arg.event.allDay ? null : (
            <span className="shrink-0 font-medium tabular-nums">{arg.timeText}</span>
          )}
          <span dir="auto" className="min-w-0 truncate">
            {arg.event.title}
          </span>
        </div>
      );
    }
    if ('area' in props) {
      const when = arg.event.allDay
        ? t('timeBlocks.calendar.allDay')
        : `${wallTime(arg.event.start)}–${wallTime(arg.event.end)}`;
      return (
        <div className="tc-area-label">
          <span aria-hidden="true" dir="auto">
            {arg.event.title}
          </span>
          <span className="sr-only">
            {t('timeBlocks.calendar.areaLabel', { title: arg.event.title, when })}
          </span>
        </div>
      );
    }
    // On a fill the source icon takes the fill's ink; in a list (no fill) it stays muted. Travel's
    // label sits on a plate of its own fill, never on the stripes (a list row has none).
    const list = arg.view.type.startsWith('list');
    const plate = props.role === 'travel' && !list;
    return (
      <div
        className={cn(
          'flex min-w-0 items-center gap-1 px-1 text-[11px] leading-4',
          plate && 'w-fit max-w-full rounded-sm',
        )}
        style={plate ? { backgroundColor: paintOf(props).fill } : undefined}
      >
        {props.dueOnly ? (
          <CalendarClock aria-hidden="true" className="size-3 shrink-0" data-due-marker />
        ) : null}
        {props.tone === undefined ? null : <ToneMark tone={props.tone} />}
        {arg.timeText === '' || arg.event.allDay ? null : (
          <span className="shrink-0 font-medium tabular-nums">{arg.timeText}</span>
        )}
        {props.legMode === null ? (
          <SourceIcon
            source={ringProvider(props.provider)}
            className={cn('shrink-0', !list && '[&>svg]:text-current')}
          />
        ) : (
          <LegModeIcon mode={props.legMode} />
        )}
        <span dir="auto" className="min-w-0 truncate">
          {arg.event.title}
        </span>
        {props.conflict ? <ConflictMark wordsClassName="tc-leg-words" /> : null}
        {/* A badge has its own surface: the page ink, not the event's fill ink, reads on it. */}
        {props.badges.map((badge) => (
          <span
            key={badge}
            className="shrink-0 rounded-sm bg-sunken px-1 text-[10px] text-foreground"
          >
            {badge}
          </span>
        ))}
      </div>
    );
  };

  const describe = (arg: EventMountArg) => {
    if (arg.isMirror) {
      return;
    }
    const props = arg.event.extendedProps as CalendarEventProps | CalendarAreaProps;
    arg.el.setAttribute('data-item-id', props.rowId);
    arg.el.setAttribute('data-family', props.family);
    if ('area' in props) {
      // The tint alone is close to the card: a 1px edge in the Scheduled step outlines it.
      arg.el.setAttribute('data-role', 'area');
      arg.el.style.setProperty('--tc-edge', colourVar(props.family, 'scheduled'));
      return;
    }
    arg.el.setAttribute('data-role', props.role);
    const { stripe } = paintOf(props);
    if (stripe !== null) {
      arg.el.style.setProperty('--tc-hatch', hatchBackground(stripe));
    }
    const when = arg.event.allDay ? t('timeBlocks.calendar.allDay') : wallTime(arg.event.start);
    const source = t(sourceNameKey(props.provider as never));
    const label = t(
      props.dueOnly ? 'timeBlocks.calendar.dueLabel' : 'timeBlocks.calendar.eventLabel',
      { title: arg.event.title, when, source },
    );
    if (props.legMode !== null) {
      // A leg says what is wrong with it, for anyone who can't see the red edge.
      arg.el.setAttribute('data-leg-mode', props.legMode);
      arg.el.setAttribute('data-conflict', String(props.conflict));
      arg.el.setAttribute('data-past', String(props.past));
      arg.el.setAttribute('data-anchor-moved', String(props.anchorMoved));
    }
    arg.el.setAttribute(
      'aria-label',
      props.conflict ? `${label}. ${t('travel.leg.conflict')}` : label,
    );
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
            {canWrite ? (
              <Button
                variant="outline"
                size="icon-sm"
                aria-label={t('scheduled.calendar.newBlock')}
                title={t('scheduled.calendar.newBlock')}
                data-calendar-new-block=""
                onClick={() => {
                  openNewItem({ kind: 'block' });
                }}
              >
                <Plus aria-hidden="true" />
              </Button>
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
        {displayed.length === 0 && areas.length === 0 && data.data !== undefined ? (
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
            // Month's timed events as filled blocks too (not dots): every event shows its colour.
            eventDisplay="block"
            eventInteractive
            displayEventEnd={false}
            selectable={selectable}
            selectMirror
            selectAllow={blockSpanAllowed}
            select={createFromSelection}
            events={events}
            eventContent={renderEvent}
            eventDidMount={describe}
            eventClick={(arg) => {
              arg.jsEvent.preventDefault();
              const props = arg.event.extendedProps as CalendarEventProps | CalendarAreaProps;
              // A background area is the time behind the events and never gets here.
              openItem(
                props.rowId,
                props.originalStart === null ? undefined : new Date(props.originalStart),
              );
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
