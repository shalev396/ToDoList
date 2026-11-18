import { useId, useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  DndContext,
  pointerWithin,
  rectIntersection,
  type CollisionDetection,
  DragOverlay,
  KeyboardSensor,
  PointerSensor,
  TouchSensor,
  useDraggable,
  useDroppable,
  useSensor,
  useSensors,
  type Announcements,
  type ClientRect,
  type DragEndEvent,
  type DragStartEvent,
  type UniqueIdentifier,
} from '@dnd-kit/core';
import { GripVertical, SquareKanban } from 'lucide-react';
import { useSetItemStatus } from '@/api/queries/blockItems';
import { BoardCard } from '@/components/items/BoardCard';
import { cn } from '@/lib/utils';
import { useRowColours } from '@/features/colours/useColours';
import { useItemParam } from '@/features/items/useItemParam';
import { SourceLink } from '@/features/items/SourceLink';
import type { ItemQueryRow } from '@api-types/builder';
import type { ItemColour } from '@api-types/colours';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';
import type { DisplayedRow } from '../rules/applyDisplayRules';
import { kanbanColumns } from './data/kanbanColumns';
import { clipToViewport, isDraggable, pointIn, statusAfterDrop } from './data/kanbanDrag';
import { BadgeChips, ToneRow } from './data/RowParts';
import { displayProvider, dateOf } from './data/rows';
import { truncateText } from './data/truncate';
import { useDataBlock } from './data/useDataBlock';
import { rowPath } from './data/rows';
import { topicLabel } from '@/features/workspaces/topics';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { ScrollArea } from '@/components/ui/scroll-area';

type Entry = DisplayedRow<ItemQueryRow>;

function groupKeyOf(entry: Entry, field: string): string {
  if (field === 'status') {
    return entry.row.status;
  }
  let current: unknown = entry.row;
  for (const part of rowPath(field).split('.')) {
    current =
      typeof current === 'object' && current !== null
        ? (current as Record<string, unknown>)[part]
        : undefined;
  }
  return typeof current === 'string' || typeof current === 'number' ? String(current) : '';
}

function Card({
  entry,
  now,
  timeZone,
  colour,
  dragging = false,
}: {
  entry: Entry;
  now: Date;
  timeZone: string;
  colour: ItemColour;
  dragging?: boolean;
}) {
  const { t } = useTranslation();
  const { row, tone, badges } = entry;
  const draggable = isDraggable(row);
  const { attributes, listeners, setNodeRef, isDragging } = useDraggable({
    id: row.id,
    disabled: !draggable,
  });
  const title = truncateText(row.title, 160) || t('dataBlocks.noTitle');
  const assignee = row.assignees[0];
  const { openItem } = useItemParam();

  return (
    <li
      ref={setNodeRef}
      className={cn('flex items-start gap-0.5', isDragging && !dragging && 'opacity-40')}
    >
      {draggable ? (
        <button
          type="button"
          {...attributes}
          {...listeners}
          aria-label={t('dataBlocks.kanban.dragHandle', { title })}
          className="mt-2 flex size-8 shrink-0 touch-none items-center justify-center rounded-sm text-muted-foreground hover:bg-sunken hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:size-11"
        >
          <GripVertical aria-hidden="true" className="size-4" />
        </button>
      ) : null}
      <ToneRow tone={tone} className="flex-1">
        <BoardCard
          title={title}
          source={displayProvider(row.source.provider)}
          now={now}
          reference={row.source.key ?? undefined}
          due={dateOf(row.dueAt)}
          timeZone={timeZone}
          assignee={assignee}
          colour={colour}
          onOpen={() => {
            openItem(row.id);
          }}
          openIn={
            <>
              <BadgeChips badges={badges} />
              <SourceLink source={row.source} title={title} />
            </>
          }
        />
      </ToneRow>
    </li>
  );
}

function Column({
  id,
  label,
  entries,
  now,
  timeZone,
  droppable,
  colourOf,
}: {
  id: string;
  label: string;
  entries: Entry[];
  now: Date;
  timeZone: string;
  droppable: boolean;
  colourOf: (rowId: string) => ItemColour;
}) {
  const { t } = useTranslation();
  const { setNodeRef, isOver } = useDroppable({ id, disabled: !droppable });
  const headingId = useId();
  return (
    <div className="flex min-h-0 w-64 shrink-0 flex-col gap-2 md:h-full max-md:w-full">
      <h3
        id={headingId}
        className="flex shrink-0 items-center gap-2 px-1 text-xs font-semibold text-muted-foreground"
      >
        <span className="truncate">{label}</span>
        <span className="rounded-full bg-sunken px-1.5 tabular-nums">
          <span className="sr-only">{t('dataBlocks.kanban.cards', { count: entries.length })}</span>
          <span aria-hidden="true">{entries.length}</span>
        </span>
      </h3>
      <div
        data-column-viewport={id}
        className={cn(
          'min-h-0 flex-1 overflow-y-auto overscroll-contain rounded-md bg-sunken/60 transition-colors max-md:max-h-[60dvh]',
          isOver && 'bg-sunken ring-2 ring-ring',
        )}
      >
        <div ref={setNodeRef} data-column={id} className="flex min-h-full flex-col gap-2 p-1.5">
          {entries.length === 0 ? (
            <p className="px-1 py-2 text-xs text-muted-foreground">
              {droppable ? t('dataBlocks.kanban.emptyColumn') : ''}
            </p>
          ) : (
            <ul aria-labelledby={headingId} className="m-0 flex list-none flex-col gap-2 p-0">
              {entries.map((entry) => (
                <Card
                  key={entry.row.id}
                  entry={entry}
                  now={now}
                  timeZone={timeZone}
                  colour={colourOf(entry.row.id)}
                />
              ))}
            </ul>
          )}
        </div>
      </div>
    </div>
  );
}

/**
 * The column under the pointer. A column's droppable sits inside its own scrolled viewport and
 * extends past it, so each rect is clipped to that viewport first: a pointer over the next column
 * never lands on a column whose overflow reaches under it. With the keyboard (no pointer) the
 * best-overlapping clipped column wins.
 */
const visibleCollisions: CollisionDetection = (args) => {
  const { pointerCoordinates, droppableContainers, droppableRects } = args;
  const clippedRects = new Map<UniqueIdentifier, ClientRect>();
  const containers = droppableContainers.filter((container) => {
    const rect = droppableRects.get(container.id);
    const viewport = container.node.current?.closest('[data-column-viewport]');
    if (rect === undefined || !viewport) {
      return false;
    }
    const clipped = clipToViewport(rect, viewport.getBoundingClientRect());
    if (clipped === null || (pointerCoordinates && !pointIn(pointerCoordinates, clipped))) {
      return false;
    }
    clippedRects.set(container.id, {
      ...clipped,
      width: clipped.right - clipped.left,
      height: clipped.bottom - clipped.top,
    });
    return true;
  });
  const clipped = { ...args, droppableContainers: containers, droppableRects: clippedRects };
  const within = pointerWithin(clipped);
  return within.length > 0 ? within : rectIntersection(clipped);
};

/**
 * Kanban (FRONTEND.md §5): Trello-style columns by status (or the query's first groupBy field).
 * Only local items are draggable (a drag handle works with the mouse, touch and the keyboard, with
 * announcements in the page language); dropping one on a status column PATCHes its status.
 * Mirrored cards open in their own app.
 */
export default function KanbanBlock({ dashboard, block }: BlockComponentProps) {
  const { t } = useTranslation();
  const { query, rows, loadState, now, timeZone } = useDataBlock(dashboard, block);
  const itemRows = useMemo(() => rows.map((entry) => entry.row), [rows]);
  const colourOf = useRowColours(itemRows);
  const setStatus = useSetItemStatus();
  const [activeId, setActiveId] = useState<string | null>(null);
  const field = block.query?.groupBy?.[0] ?? 'status';
  const { topics } = useCurrentWorkspace();
  const byStatus = field === 'status';

  const columns = useMemo(
    () => kanbanColumns(rows, (entry) => groupKeyOf(entry, field), byStatus),
    [rows, field, byStatus],
  );
  const labelOf = (key: string): string => {
    if (byStatus) {
      return t(`dataBlocks.status.${key}`, { defaultValue: key });
    }
    if (field === 'topic') {
      return topicLabel(topics, key === '' ? null : key, t('topics.unsorted'));
    }
    return key === '' ? t('dataBlocks.chart.unknown') : key;
  };

  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 6 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 200, tolerance: 8 } }),
    useSensor(KeyboardSensor),
  );
  const byId = (id: unknown): Entry | undefined => rows.find((entry) => entry.row.id === id);
  const titleOf = (id: unknown): string => truncateText(byId(id)?.row.title ?? '', 80);

  const announcements: Announcements = {
    onDragStart: ({ active }) => t('dataBlocks.kanban.pickedUp', { title: titleOf(active.id) }),
    onDragOver: () => undefined,
    onDragEnd: ({ active, over }) => {
      const entry = byId(active.id);
      const next =
        entry === undefined ? null : statusAfterDrop(entry.row, over ? String(over.id) : null);
      return next === null
        ? t('dataBlocks.kanban.cancelled')
        : t('dataBlocks.kanban.movedTo', {
            title: titleOf(active.id),
            status: t(`dataBlocks.status.${next}`),
          });
    },
    onDragCancel: () => t('dataBlocks.kanban.cancelled'),
  };

  const onDragEnd = (event: DragEndEvent) => {
    setActiveId(null);
    const entry = byId(event.active.id);
    if (entry === undefined || !byStatus) {
      return;
    }
    const next = statusAfterDrop(entry.row, event.over ? String(event.over.id) : null);
    if (next !== null) {
      setStatus(entry.row.id, next);
    }
  };
  const onDragStart = (event: DragStartEvent) => {
    setActiveId(String(event.active.id));
  };
  const active = activeId === null ? undefined : byId(activeId);
  const hasLocal = rows.some((entry) => isDraggable(entry.row));
  const status = loadState !== 'ready' ? loadState : rows.length === 0 ? 'empty' : 'ready';

  return (
    <BlockFrame
      title={blockTitle(block, t)}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<SquareKanban />}
      emptyMessage={t('dataBlocks.kanban.empty')}
    >
      <DndContext
        sensors={sensors}
        collisionDetection={visibleCollisions}
        onDragStart={onDragStart}
        onDragEnd={onDragEnd}
        onDragCancel={() => {
          setActiveId(null);
        }}
        accessibility={{
          announcements,
          screenReaderInstructions: { draggable: t('dataBlocks.kanban.dragHint') },
        }}
      >
        <ScrollArea className="h-full min-h-0" viewportClassName="[&>div]:!h-full">
          <div className="flex h-full min-h-0 gap-3 pb-3 max-md:h-auto max-md:flex-col">
            {columns.map((column) => (
              <Column
                key={column.key}
                id={column.key}
                label={labelOf(column.key)}
                entries={column.rows}
                now={now}
                timeZone={timeZone}
                droppable={byStatus && hasLocal}
                colourOf={colourOf}
              />
            ))}
          </div>
        </ScrollArea>
        <DragOverlay>
          {active === undefined ? null : (
            <div className="rounded-md bg-card shadow-(--shadow-overlay)">
              <BoardCard
                title={truncateText(active.row.title, 160)}
                source={displayProvider(active.row.source.provider)}
                now={now}
                due={dateOf(active.row.dueAt)}
                timeZone={timeZone}
                colour={colourOf(active.row.id)}
              />
            </div>
          )}
        </DragOverlay>
      </DndContext>
    </BlockFrame>
  );
}
