import { useCallback, useEffect, useMemo, useRef, useState, type CSSProperties } from 'react';
import { useTranslation } from 'react-i18next';
import FullCalendar from '@fullcalendar/react';
import interactionPlugin, { Draggable } from '@fullcalendar/interaction';
import timeGridPlugin from '@fullcalendar/timegrid';
import heLocale from '@fullcalendar/core/locales/he';
import type {
  DateSelectArg,
  DateSpanApi,
  EventClickArg,
  EventContentArg,
  EventDropArg,
  EventInput,
  EventMountArg,
} from '@fullcalendar/core';
import type { DropArg, EventDragStopArg } from '@fullcalendar/interaction';
import { ChevronLeft, ChevronRight, Plus } from 'lucide-react';
import { useBlockData } from '@/api/queries/blocks';
import { Button } from '@/components/ui/button';
import { dateLocale, shortDate, timeOfDay } from '@/components/items/format';
import { SourceIcon } from '@/components/items/SourceIcon';
import { sourceNameKey } from '@/components/items/sources';
import { colourVar } from '@/features/colours/palette';
import { useRowColours } from '@/features/colours/useColours';
import { useItemParam } from '@/features/items/useItemParam';
import { useShellUi } from '@/features/shell/shellUi';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { useNow } from '@/hooks/useNow';
import type { ItemQueryRow } from '@api-types/builder';
import { BlockFrame } from '../../BlockFrame';
import { blockTitle } from '../../chrome';
import type { BlockComponentProps } from '../../registry/types';
import { applyDisplayRules } from '../../rules/applyDisplayRules';
import { usePageVars } from '../../variables/pageVars';
import {
  areaTagsByDay,
  toAreaEventInput,
  toEventInput,
  type CalendarAreaProps,
  type CalendarEventProps,
} from '../calendar/calendarEvents';
import {
  READABLE_PX,
  SLOT_PX,
  TIME_GRID_LAYOUT,
  chipLayout,
  chipMinutes,
} from '../calendar/chipLayout';
import { zonedParts, zonedTime } from '../clock/ClockRing.math';
import { ringProvider } from '../clock/clockModel';
import { itemRowsOf } from '../data/rows';
import { isolateLtr } from '../time/areas';
import { inactiveKey } from '../time/inactive';
import {
  visibleRange,
  wallDate,
  wallString,
  withSeriesFields,
  type WeekStart,
} from '../time/occurrences';
import { TimesheetAreaTag } from './TimesheetAreaTag';
import { TodoPanel, type PanelTodo } from './TodoPanel';
import {
  PLANNED_MINUTES,
  SNAP_DURATION,
  buildTimesheet,
  plannedAtFromDrop,
  plannedEventInput,
  selectionPreset,
  truncatedTodos,
  type PlannedEventProps,
} from './timesheetModel';
import { showsBlocks, timesheetTopicId } from './timesheetTopic';
import { usePlanTodo } from './usePlanTodo';

const PLUGINS = [timeGridPlugin, interactionPlugin];
const EVENT_TIME = { hour: '2-digit', minute: '2-digit', hour12: false } as const;
/** The week grid opens scrolled to this hour (the calendar's default start). */
const SCROLL_TIME = '07:00:00';
/** The longest span a drag across the grid paints: a day. */
const LONGEST_DRAG_MS = 24 * 3600_000;
/**
 * A press this long starts dragging a to-do or a chip on a touch screen (FullCalendar's default is
 * a second). Painting across the grid keeps FullCalendar's second, as in the calendar block, so a
 * finger resting before a scroll or a slow tap on an area never starts one.
 */
const LONG_PRESS_MS = 300;
/** A mouse moves this far before a press becomes a selection, so a click opens what it hits. */
const SELECT_MIN_PX = 6;

type EventProps = CalendarEventProps | CalendarAreaProps | PlannedEventProps;

/** FullCalendar's `UTC` dates hold the workspace's wall clock: `2026-11-22T13:00:00`. */
const wallOf = (date: Date): string => date.toISOString().slice(0, 19);

function noonOf(date: Date, timeZone: string): Date {
  const p = zonedParts(date, timeZone);
  return zonedTime(p.year, p.month, p.day, 12, 0, timeZone);
}

function shiftWeek(anchor: Date, direction: -1 | 1, timeZone: string): Date {
  const p = zonedParts(anchor, timeZone);
  return zonedTime(p.year, p.month, p.day + direction * 7, 12, 0, timeZone);
}

/** A drag on the grid's hours (not the all-day row), a day at most, paints. */
function paintAllowed(span: DateSpanApi): boolean {
  return !span.allDay && span.end.getTime() - span.start.getTime() <= LONGEST_DRAG_MS;
}

function isPlanned(props: EventProps): props is PlannedEventProps {
  return 'planned' in props;
}

function isArea(props: EventProps): props is CalendarAreaProps {
  return 'area' in props;
}

/** Where a pointer was let go, for a mouse or a finger. */
function releasePoint(event: MouseEvent | TouchEvent | PointerEvent): { x: number; y: number } {
  if ('changedTouches' in event) {
    const touch = event.changedTouches[0];
    return { x: touch?.clientX ?? -1, y: touch?.clientY ?? -1 };
  }
  return { x: event.clientX, y: event.clientY };
}

/**
 * The timesheet (owner's ask, 2026-11-21): a topic's painted time on a week grid (its areas as
 * bands in the topic's tint, its time blocks as events) with its open to-dos beside it, "To
 * schedule". Dragging a to-do onto the week plans it (`overlay.plannedAt`, on quarter hours, never
 * sent to its provider): a 30-minute chip at that time, which drags to move and back onto the
 * panel to unschedule (the panel's Unschedule does the same). Dropping is allowed anywhere; while
 * dragging, the painted time is drawn stronger, as guidance.
 *
 * Editors also manage the time sheet: dragging across free time opens the New sheet on an area of
 * the topic at that time (inside an area, a time block there); tapping an area or its tag in the
 * day's header opens its sheet, where it is edited (this one or every week). Mouse and touch
 * (press and hold to drag); RTL; the theme's tokens. On a narrow block (the iPad upright) the panel
 * sits above the week as a strip that folds away.
 */
export default function TimesheetBlock({ dashboard, block, editing }: BlockComponentProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const locale = dateLocale(language);
  const { workspace, settings, role } = useCurrentWorkspace();
  const canWrite = (role === 'editor' || role === 'owner') && !editing;
  const { openItem } = useItemParam();
  const { openNewItem } = useShellUi();
  const timeZone = settings?.timezone ?? 'UTC';
  const weekStart: WeekStart = settings?.weekStart ?? 'sun';
  const now = useNow();
  const { vars } = usePageVars();

  const [anchor, setAnchor] = useState(() => noonOf(new Date(), timeZone));
  const range = useMemo(
    () => visibleRange('week', anchor, timeZone, weekStart),
    [anchor, timeZone, weekStart],
  );
  const rangeVar = useMemo(
    () => ({ from: range.from.toISOString(), to: range.to.toISOString() }),
    [range],
  );
  const data = useBlockData(dashboard, block, { ...vars, range: rangeVar });
  const plan = usePlanTodo(workspace?.id ?? '', dashboard.id, block.id);

  const ruled = useMemo(
    () =>
      applyDisplayRules(itemRowsOf(data.data), block.rules, {
        now,
        timeZone,
        userId: '',
        vars,
      }),
    [data.data, block.rules, now, timeZone, vars],
  );
  // A cancelled Google occurrence (Google's id only) is titled and coloured as its series.
  const rows = useMemo(
    () => withSeriesFields(ruled.filter((entry) => !entry.hidden).map((entry) => entry.row)),
    [ruled],
  );
  // What a rule hides still takes its slot out of its series.
  const hiddenRows = useMemo(
    () => ruled.filter((entry) => entry.hidden).map((entry) => entry.row),
    [ruled],
  );
  const colourOf = useRowColours(rows);
  const showBlocks = showsBlocks(block.viz);
  const model = useMemo(
    () => buildTimesheet(rows, range, timeZone, colourOf, showBlocks, hiddenRows),
    [rows, range, timeZone, colourOf, showBlocks, hiddenRows],
  );
  const topicId = timesheetTopicId(block.query, vars);

  const events = useMemo((): EventInput[] => {
    const chips: EventInput[] = [];
    for (const row of model.planned) {
      const chip = plannedEventInput(row, colourOf(row.id));
      if (chip !== null) {
        chips.push(chip);
      }
    }
    return [
      ...model.areas.map((o) => toAreaEventInput(o, colourOf(o.row.id), timeZone)),
      ...model.timed.map((o) =>
        toEventInput({ occurrence: o, badges: [] }, timeZone, colourOf(o.row.id)),
      ),
      ...chips,
    ];
  }, [model, colourOf, timeZone]);
  const areaTags = useMemo(
    () => areaTagsByDay(model.areas, colourOf, timeZone),
    [model.areas, colourOf, timeZone],
  );

  const wallTime = useCallback(
    (date: Date | null) => (date === null ? '' : timeOfDay(date, locale, 'UTC')),
    [locale],
  );
  /** A plan as words: the day and, when it has one, the time (kept left to right). */
  const planWords = useCallback(
    (plannedAt: string) => {
      const [day = '', time] = plannedAt.split('T');
      const date = new Date(`${day}T12:00:00Z`);
      const dayText = shortDate(date, locale, 'UTC');
      return time === undefined ? dayText : `${dayText} ${isolateLtr(time)}`;
    },
    [locale],
  );

  const panelTodos = useMemo(
    (): PanelTodo[] =>
      model.todos.map((row: ItemQueryRow) => ({
        row,
        colour: colourOf(row.id),
        plannedText:
          row.overlay.plannedAt === null ? null : planWords(row.overlay.plannedAt.slice(0, 16)),
        dueText: row.dueAt === null ? null : shortDate(new Date(row.dueAt), locale, timeZone),
      })),
    [model.todos, colourOf, planWords, locale, timeZone],
  );

  // ─── FullCalendar ────────────────────────────────────────────────────────────────────────────

  const calendar = useRef<FullCalendar>(null);
  const panel = useRef<HTMLElement>(null);
  // State, not a ref: the panel mounts only once the data has loaded (the frame shows a skeleton
  // until then), and the Draggable must attach to it then.
  const [list, setList] = useState<HTMLDivElement | null>(null);

  useEffect(() => {
    // After the commit: FullCalendar renders a new date with flushSync, which React refuses
    // inside a lifecycle (as the calendar block does).
    let live = true;
    queueMicrotask(() => {
      if (live) {
        calendar.current?.getApi().gotoDate(wallDate(anchor, timeZone));
      }
    });
    return () => {
      live = false;
    };
  }, [anchor, timeZone]);

  // The panel's to-dos drag onto the grid (FullCalendar's Draggable, touch with a long press).
  useEffect(() => {
    if (!canWrite || list === null) {
      return;
    }
    const draggable = new Draggable(list, {
      itemSelector: '[data-timesheet-todo]',
      longPressDelay: LONG_PRESS_MS,
      eventData: (el) => ({
        title: el.getAttribute('data-title') ?? '',
        duration: `00:${String(PLANNED_MINUTES)}:00`,
        // The drop plans the to-do; the chip comes from its new plan, not from FullCalendar.
        create: false,
      }),
    });
    return () => {
      draggable.destroy();
    };
  }, [canWrite, list]);

  const onDrop = (arg: DropArg) => {
    const itemId = arg.draggedEl.getAttribute('data-todo-id');
    if (itemId !== null) {
      plan.mutate({ itemId, plannedAt: plannedAtFromDrop(arg.date, arg.allDay) });
    }
  };

  const onEventDrop = (arg: EventDropArg) => {
    const props = arg.event.extendedProps as EventProps;
    // The chip moves with its new plan (the optimistic write); FullCalendar's own move is undone.
    arg.revert();
    if (isPlanned(props) && arg.event.start !== null) {
      plan.mutate({
        itemId: props.rowId,
        plannedAt: plannedAtFromDrop(arg.event.start, arg.event.allDay),
      });
    }
  };

  const onEventDragStop = (arg: EventDragStopArg) => {
    const props = arg.event.extendedProps as EventProps;
    const box = panel.current?.getBoundingClientRect();
    if (!isPlanned(props) || box === undefined) {
      return;
    }
    const { x, y } = releasePoint(arg.jsEvent);
    if (x >= box.left && x <= box.right && y >= box.top && y <= box.bottom) {
      plan.mutate({ itemId: props.rowId, plannedAt: null });
    }
  };

  const onSelect = (arg: DateSelectArg) => {
    arg.view.calendar.unselect();
    openNewItem(
      selectionPreset(
        { startWall: wallOf(arg.start), endWall: wallOf(arg.end) },
        model.areas,
        timeZone,
        topicId,
      ),
    );
  };

  const onEventClick = (arg: EventClickArg) => {
    arg.jsEvent.preventDefault();
    const props = arg.event.extendedProps as EventProps;
    if (isPlanned(props)) {
      openItem(props.rowId);
      return;
    }
    openItem(props.rowId, props.originalStart === null ? undefined : new Date(props.originalStart));
  };

  const renderEvent = (arg: EventContentArg) => {
    if (arg.isMirror && !('rowId' in arg.event.extendedProps)) {
      // The span being dragged across: its times.
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
    const props = arg.event.extendedProps as EventProps;
    if (isArea(props)) {
      const when = `${wallTime(arg.event.start)}–${wallTime(arg.event.end)}`;
      return (
        <span className="sr-only">
          {t('timeBlocks.calendar.areaLabel', { title: arg.event.title, when })}
        </span>
      );
    }
    const { provider } = props;
    const layout =
      !arg.event.allDay && arg.event.start !== null
        ? chipLayout(chipMinutes(arg.event.start, arg.event.end, arg.isStart, arg.isEnd), false)
        : null;
    const icon = (
      <SourceIcon
        source={ringProvider(provider)}
        className="shrink-0 [&>svg]:size-3 [&>svg]:text-current"
      />
    );
    if (layout?.kind === 'stacked') {
      return (
        <div
          className="tc-chip flex max-h-full min-w-0 flex-col overflow-hidden px-1 py-px text-[11px] leading-[13px]"
          data-chip-layout="stacked"
        >
          <span className="flex h-3.5 shrink-0 items-center gap-1 overflow-hidden">{icon}</span>
          <span
            dir="auto"
            className="tc-chip-title min-w-0 overflow-hidden [overflow-wrap:anywhere]"
            style={{
              display: '-webkit-box',
              WebkitBoxOrient: 'vertical',
              WebkitLineClamp: layout.titleLines,
            }}
            data-chip-title=""
          >
            {arg.event.title}
          </span>
        </div>
      );
    }
    return (
      <div
        className="tc-chip flex max-h-full min-w-0 items-center gap-1 overflow-hidden px-1 py-px text-[11px] leading-[13px]"
        data-chip-layout="inline"
      >
        {icon}
        <span dir="auto" className="min-w-0 truncate" data-chip-title="">
          {arg.event.title}
        </span>
      </div>
    );
  };

  const describe = (arg: EventMountArg) => {
    if (arg.isMirror) {
      return;
    }
    const props = arg.event.extendedProps as EventProps;
    arg.el.setAttribute('data-item-id', props.rowId);
    arg.el.setAttribute('data-family', props.family);
    // Cancelled or disabled (time/inactive.ts): faded, its time free; its name says so.
    const off = props.inactive === null ? null : t(inactiveKey(props.inactive));
    if (props.inactive !== null) {
      arg.el.setAttribute('data-inactive', props.inactive);
    }
    if (isArea(props)) {
      arg.el.setAttribute('data-role', 'area');
      arg.el.style.setProperty('--tc-edge', colourVar(props.family, 'scheduled'));
      return;
    }
    const source = t(sourceNameKey(props.provider as never));
    let name: string;
    if (isPlanned(props)) {
      arg.el.setAttribute('data-role', 'planned');
      arg.el.setAttribute('data-planned-at', props.plannedAt);
      name = t('timeBlocks.timesheet.plannedLabel', {
        title: arg.event.title,
        when: planWords(props.plannedAt),
      });
    } else {
      arg.el.setAttribute('data-role', props.role);
      const when = arg.event.allDay
        ? t('timeBlocks.calendar.allDay')
        : isolateLtr(`${wallTime(arg.event.start)}–${wallTime(arg.event.end)}`);
      name = t('timeBlocks.calendar.eventLabel', { title: arg.event.title, when, source });
    }
    if (off !== null) {
      name = `${name}. ${off}`;
    }
    arg.el.setAttribute('aria-label', name);
    arg.el.setAttribute('title', name);
  };

  const status = data.isLoading ? 'loading' : data.isError ? 'error' : 'ready';
  const title = `${shortDate(range.from, locale, timeZone)} – ${shortDate(
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
        canWrite ? (
          <Button
            variant="outline"
            size="sm"
            className="pointer-coarse:h-11"
            data-timesheet-new-area=""
            onClick={() => {
              openNewItem({ kind: 'area', ...(topicId === null ? {} : { topicId }) });
            }}
          >
            <Plus aria-hidden="true" />
            {t('timeBlocks.timesheet.newArea')}
          </Button>
        ) : undefined
      }
    >
      <div
        className="@container flex h-full min-h-0 flex-col gap-2"
        data-timesheet=""
        dir={language === 'he' ? 'rtl' : 'ltr'}
      >
        <div className="flex shrink-0 items-center gap-1">
          <Button
            variant="outline"
            size="icon-sm"
            className="pointer-coarse:size-11"
            aria-label={t('timeBlocks.calendar.previous')}
            onClick={() => {
              setAnchor((current) => shiftWeek(current, -1, timeZone));
            }}
          >
            <ChevronLeft aria-hidden="true" className="rtl:rotate-180" />
          </Button>
          <Button
            variant="outline"
            size="icon-sm"
            className="pointer-coarse:size-11"
            aria-label={t('timeBlocks.calendar.next')}
            onClick={() => {
              setAnchor((current) => shiftWeek(current, 1, timeZone));
            }}
          >
            <ChevronRight aria-hidden="true" className="rtl:rotate-180" />
          </Button>
          <Button
            variant="ghost"
            size="sm"
            className="pointer-coarse:h-11"
            onClick={() => {
              setAnchor(noonOf(new Date(), timeZone));
            }}
          >
            {t('timeBlocks.calendar.today')}
          </Button>
          <p
            aria-live="polite"
            className="min-w-0 flex-1 truncate text-end text-[13px] font-medium"
            data-timesheet-title=""
          >
            {title}
          </p>
        </div>
        <div className="flex min-h-0 flex-1 flex-col gap-3 @min-[60rem]:flex-row">
          <TodoPanel
            ref={panel}
            listRef={setList}
            todos={panelTodos}
            truncated={truncatedTodos(data.data)}
            canWrite={canWrite}
            onOpen={(itemId) => {
              openItem(itemId);
            }}
            onUnschedule={(itemId) => {
              plan.mutate({ itemId, plannedAt: null });
            }}
          />
          <div className="flex min-h-0 min-w-0 flex-1 flex-col gap-2">
            {model.areas.length === 0 && data.data !== undefined ? (
              <p className="shrink-0 text-[13px] text-muted-foreground" data-timesheet-no-areas="">
                {t(
                  canWrite
                    ? 'timeBlocks.timesheet.noAreas'
                    : 'timeBlocks.timesheet.noAreasReadOnly',
                )}
              </p>
            ) : null}
            <div
              role="region"
              aria-label={t('timeBlocks.timesheet.grid')}
              className="todolist-calendar timesheet-grid min-h-80 flex-1"
              data-timesheet-grid=""
              dir={language === 'he' ? 'rtl' : 'ltr'}
              style={
                {
                  '--tc-slot': `${String(SLOT_PX)}px`,
                  '--tc-line': `${String(READABLE_PX - 1)}px`,
                } as CSSProperties
              }
            >
              <FullCalendar
                ref={calendar}
                plugins={PLUGINS}
                initialView="timeGridWeek"
                initialDate={wallDate(anchor, timeZone)}
                timeZone="UTC"
                now={wallString(now, timeZone)}
                nowIndicator
                headerToolbar={false}
                locales={[heLocale]}
                locale={language === 'he' ? 'he' : 'en'}
                direction={language === 'he' ? 'rtl' : 'ltr'}
                firstDay={weekStart === 'sun' ? 0 : 1}
                height="100%"
                scrollTime={SCROLL_TIME}
                allDaySlot
                allDayText={t('timeBlocks.calendar.allDay')}
                {...TIME_GRID_LAYOUT}
                snapDuration={SNAP_DURATION}
                defaultTimedEventDuration={`00:${String(PLANNED_MINUTES)}:00`}
                eventTimeFormat={EVENT_TIME}
                slotLabelFormat={EVENT_TIME}
                displayEventEnd={false}
                eventInteractive
                editable={false}
                droppable={canWrite}
                drop={onDrop}
                eventDrop={onEventDrop}
                eventDragStop={onEventDragStop}
                eventLongPressDelay={LONG_PRESS_MS}
                selectable={canWrite}
                selectMirror
                selectMinDistance={SELECT_MIN_PX}
                selectAllow={paintAllowed}
                select={onSelect}
                events={events}
                eventContent={renderEvent}
                eventDidMount={describe}
                eventClick={onEventClick}
                dayHeaderContent={(arg) => {
                  const tags = areaTags.get(arg.date.toISOString().slice(0, 10));
                  if (tags === undefined) {
                    return arg.text;
                  }
                  return (
                    <span className="flex min-w-0 flex-col gap-0.5" data-area-tags="">
                      <span className="truncate">{arg.text}</span>
                      {tags.map((tag) => (
                        <TimesheetAreaTag
                          key={tag.key}
                          tag={tag}
                          onOpen={() => {
                            openItem(
                              tag.rowId,
                              tag.originalStart === null ? undefined : new Date(tag.originalStart),
                            );
                          }}
                        />
                      ))}
                    </span>
                  );
                }}
              />
            </div>
          </div>
        </div>
      </div>
    </BlockFrame>
  );
}
