import { useId, useState, type Ref } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarX2, ChevronDown } from 'lucide-react';
import { Button } from '@/components/ui/button';
import { SourceIcon } from '@/components/items/SourceIcon';
import { sourceNameKey } from '@/components/items/sources';
import { ColourDot } from '@/features/colours/ColourDot';
import { cn } from '@/lib/utils';
import type { ItemQueryRow } from '@api-types/builder';
import type { ItemColour } from '@api-types/colours';
import { ringProvider } from '../clock/clockModel';

/** One to-do of the panel, with its words worked out by the block. */
export interface PanelTodo {
  row: ItemQueryRow;
  colour: ItemColour;
  /** "Mon 24 10:30": its plan in words; null when it has none. */
  plannedText: string | null;
  /** Its due date in words; null when it has none. */
  dueText: string | null;
}

interface TodoPanelProps {
  ref: Ref<HTMLElement>;
  /** The element FullCalendar's Draggable listens on (its items are `[data-timesheet-todo]`). */
  listRef: Ref<HTMLDivElement>;
  todos: readonly PanelTodo[];
  /** The row cap left to-dos out: how many show, of how many (timesheetModel `truncatedTodos`). */
  truncated: { shown: number; total: number } | null;
  /** Editors drag and unschedule; everyone opens. */
  canWrite: boolean;
  onOpen: (itemId: string) => void;
  onUnschedule: (itemId: string) => void;
}

/**
 * "To schedule": the timesheet's open to-dos, the unplanned first, then the planned (their plan
 * under the title, and Unschedule). Each drags onto the week (a long press on a touch screen) and
 * opens its sheet on a tap. Beside the week on a wide block; above it on a narrow one (the iPad
 * upright), as wrapping chips under a heading that folds them away.
 */
export function TodoPanel({
  ref,
  listRef,
  todos,
  truncated,
  canWrite,
  onOpen,
  onUnschedule,
}: TodoPanelProps) {
  const { t } = useTranslation();
  const headingId = useId();
  const listId = useId();
  const [open, setOpen] = useState(true);
  const unplanned = todos.filter((todo) => todo.plannedText === null);
  const planned = todos.filter((todo) => todo.plannedText !== null);

  const group = (label: string, entries: readonly PanelTodo[], key: string) =>
    entries.length === 0 ? null : (
      <div className="flex min-w-0 flex-col gap-1" data-timesheet-group={key}>
        <p className="text-[11px] font-medium text-muted-foreground">{label}</p>
        <ul className="m-0 flex min-w-0 list-none flex-wrap gap-1.5 p-0 @min-[60rem]:flex-col @min-[60rem]:flex-nowrap">
          {entries.map((todo) => (
            <TodoRow
              key={todo.row.id}
              todo={todo}
              canWrite={canWrite}
              onOpen={onOpen}
              onUnschedule={onUnschedule}
            />
          ))}
        </ul>
      </div>
    );

  return (
    <section
      ref={ref}
      aria-labelledby={headingId}
      data-timesheet-panel=""
      className="flex max-h-[40%] shrink-0 flex-col gap-2 rounded-md border bg-sunken/50 p-2 @min-[60rem]:max-h-none @min-[60rem]:w-72 @min-[60rem]:min-h-0"
    >
      <h3
        id={headingId}
        className="sr-only @min-[60rem]:not-sr-only @min-[60rem]:text-[13px] @min-[60rem]:font-semibold"
      >
        {t('timeBlocks.timesheet.panel')}
      </h3>
      <button
        type="button"
        aria-expanded={open}
        aria-controls={listId}
        data-timesheet-panel-toggle=""
        className="flex min-h-8 items-center gap-1 rounded-sm text-start text-[13px] font-semibold focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11 @min-[60rem]:hidden"
        onClick={() => {
          setOpen((current) => !current);
        }}
      >
        <ChevronDown
          aria-hidden="true"
          className={cn(
            'size-4 shrink-0 transition-transform',
            !open && '-rotate-90 rtl:rotate-90',
          )}
        />
        {t('timeBlocks.timesheet.panelToggle', { count: todos.length })}
      </button>
      {truncated === null ? null : (
        // Outside the list, so it shows while the strip is folded too.
        <p
          role="status"
          className="text-[12px] text-muted-foreground"
          data-timesheet-truncated={`${String(truncated.shown)}/${String(truncated.total)}`}
        >
          {t('timeBlocks.timesheet.truncated', truncated)}
        </p>
      )}
      <div
        ref={listRef}
        id={listId}
        data-timesheet-list=""
        className={cn(
          'flex min-h-0 flex-col gap-3 overflow-y-auto @min-[60rem]:flex-1',
          !open && 'hidden @min-[60rem]:flex',
        )}
      >
        {todos.length === 0 ? (
          <p className="text-[13px] text-muted-foreground">
            {t('timeBlocks.timesheet.panelEmpty')}
          </p>
        ) : (
          <>
            {canWrite ? (
              <p className="text-[12px] text-muted-foreground">
                <span className="pointer-coarse:hidden">{t('timeBlocks.timesheet.dragHint')}</span>
                <span className="hidden pointer-coarse:inline">
                  {t('timeBlocks.timesheet.dragHintTouch')}
                </span>
              </p>
            ) : null}
            {group(t('timeBlocks.timesheet.unplannedGroup'), unplanned, 'unplanned')}
            {group(t('timeBlocks.timesheet.plannedGroup'), planned, 'planned')}
          </>
        )}
      </div>
    </section>
  );
}

function TodoRow({
  todo,
  canWrite,
  onOpen,
  onUnschedule,
}: {
  todo: PanelTodo;
  canWrite: boolean;
  onOpen: (itemId: string) => void;
  onUnschedule: (itemId: string) => void;
}) {
  const { t } = useTranslation();
  const { row, colour, plannedText, dueText } = todo;
  const provider = ringProvider(row.source.provider);
  const meta =
    plannedText !== null
      ? t('timeBlocks.timesheet.plannedFor', { when: plannedText })
      : dueText !== null
        ? t('timeBlocks.timesheet.due', { when: dueText })
        : null;
  // The plan or due date is in the name too: a screen reader hears it, and on a narrow strip
  // (where the line under the title is hidden) the tooltip shows it.
  const name = [
    t('timeBlocks.timesheet.open', { title: row.title, source: t(sourceNameKey(provider)) }),
    ...(meta === null ? [] : [meta]),
  ].join(', ');
  return (
    <li
      data-timesheet-todo=""
      data-todo-id={row.id}
      data-title={row.title}
      data-planned={plannedText === null ? 'false' : 'true'}
      className={cn(
        'flex max-w-64 min-w-0 items-center gap-0.5 rounded-md border bg-card text-[13px] select-none [-webkit-touch-callout:none] @min-[60rem]:max-w-none',
        canWrite && 'cursor-grab active:cursor-grabbing',
      )}
    >
      <button
        type="button"
        className="flex min-h-8 min-w-0 flex-1 items-center gap-1.5 rounded-md px-1.5 py-1 text-start focus-visible:outline-2 focus-visible:outline-ring pointer-coarse:min-h-11"
        aria-label={name}
        title={name}
        onClick={() => {
          onOpen(row.id);
        }}
      >
        <ColourDot colour={colour} />
        <SourceIcon source={provider} className="shrink-0" />
        {/* Each line keeps its own direction (so it reads, and is cut, the right way round) and
            sits on the page's start side (items-start): a Hebrew title in an English page lines
            up with the others. */}
        <span className="flex min-w-0 flex-col items-start">
          <span dir="auto" className="max-w-full truncate" data-todo-title="">
            {row.title}
          </span>
          {meta === null ? null : (
            <span
              dir="auto"
              className="hidden max-w-full truncate text-[11px] text-muted-foreground @min-[60rem]:block"
              data-todo-meta=""
            >
              {meta}
            </span>
          )}
        </span>
      </button>
      {plannedText !== null && canWrite ? (
        <Button
          type="button"
          variant="ghost"
          size="icon-sm"
          className="shrink-0 pointer-coarse:size-11"
          aria-label={t('timeBlocks.timesheet.unscheduleLabel', { title: row.title })}
          title={t('timeBlocks.timesheet.unschedule')}
          data-timesheet-unschedule={row.id}
          onClick={() => {
            onUnschedule(row.id);
          }}
        >
          <CalendarX2 aria-hidden="true" />
        </Button>
      ) : null}
    </li>
  );
}
