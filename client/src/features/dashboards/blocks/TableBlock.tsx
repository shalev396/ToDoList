import { useMemo, useState } from 'react';
import { useTranslation } from 'react-i18next';
import {
  createColumnHelper,
  flexRender,
  getCoreRowModel,
  getSortedRowModel,
  useReactTable,
  type ColumnDef,
  type SortingState,
} from '@tanstack/react-table';
import { ArrowDown, ArrowUp, ArrowUpDown, Table2 } from 'lucide-react';
import { browserTimeZone, dateLocale, dueText } from '@/components/items/format';
import { SourceDot } from '@/components/items/SourceDot';
import type { Provider } from '@/components/items/types';
import { useItemParam } from '@/features/items/useItemParam';
import { SourceLink } from '@/features/items/SourceLink';
import { cn } from '@/lib/utils';
import type { ItemQueryRow } from '@api-types/builder';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';
import type { DisplayedRow } from '../rules/applyDisplayRules';
import { BadgeChips, PriorityChip } from './data/RowParts';
import { TONE_CLASS } from './data/tone';
import { dateOf } from './data/rows';
import { truncateText } from './data/truncate';
import { useDataBlock } from './data/useDataBlock';
import { rowPath } from './data/rows';
import { topicLabel } from '@/features/workspaces/topics';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';

const DEFAULT_COLUMNS = ['title', 'status', 'dueAt', 'priority', 'source.provider'];
const DATE_FIELDS: ReadonlySet<string> = new Set(['dueAt', 'startAt', 'endAt']);

/** A dotted path into a row: `source.provider`, `props.path`. */
function valueAt(row: ItemQueryRow, path: string): unknown {
  let current: unknown = row;
  for (const part of rowPath(path).split('.')) {
    if (typeof current !== 'object' || current === null || Array.isArray(current)) {
      return undefined;
    }
    current = (current as Record<string, unknown>)[part];
  }
  return current;
}

const helper = createColumnHelper<DisplayedRow<ItemQueryRow>>();

function CellText({ value }: { value: unknown }) {
  if (Array.isArray(value)) {
    return <>{value.filter((part) => typeof part === 'string').join(', ')}</>;
  }
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return <>{String(value)}</>;
  }
  return null;
}

function SortIcon({ sorted }: { sorted: false | 'asc' | 'desc' }) {
  if (sorted === 'asc') {
    return <ArrowUp aria-hidden="true" className="size-3.5" />;
  }
  if (sorted === 'desc') {
    return <ArrowDown aria-hidden="true" className="size-3.5" />;
  }
  return <ArrowUpDown aria-hidden="true" className="size-3.5 opacity-50" />;
}

/**
 * Table (FRONTEND.md §5): TanStack Table v8 in the shadcn data-table pattern. Columns come from
 * `viz.columns` (field paths) or a default set; every column sorts, the header sticks, and the
 * table scrolls sideways inside the block, never the page.
 */
export default function TableBlock({ dashboard, block }: BlockComponentProps) {
  const { t, i18n } = useTranslation();
  const { topics } = useCurrentWorkspace();
  const { query, rows, loadState, now, timeZone } = useDataBlock(dashboard, block);
  const { openItem } = useItemParam();
  const [sorting, setSorting] = useState<SortingState>([]);
  const locale = dateLocale(i18n.language);
  const zone = timeZone || browserTimeZone();

  const paths = useMemo(() => {
    const configured = block.viz['columns'];
    return Array.isArray(configured) && configured.length > 0
      ? configured.filter((path): path is string => typeof path === 'string')
      : DEFAULT_COLUMNS;
  }, [block.viz]);

  const columns = useMemo(() => {
    const dataColumns = paths.map((path): ColumnDef<DisplayedRow<ItemQueryRow>> => {
      const header = t(`dataBlocks.table.columns.${path}`, { defaultValue: path });
      return helper.accessor((entry) => valueAt(entry.row, path), {
        id: path,
        header,
        sortUndefined: 'last',
        cell: (info) => {
          const value = info.getValue();
          const entry = info.row.original;
          if (path === 'title') {
            const text = truncateText(entry.row.title, 160) || t('dataBlocks.noTitle');
            return (
              <span className="flex items-center gap-2">
                <button
                  type="button"
                  title={entry.row.title}
                  onClick={() => {
                    openItem(entry.row.id);
                  }}
                  className="block max-w-[32ch] min-w-0 truncate rounded-sm text-start hover:underline focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                >
                  {text}
                </button>
                <BadgeChips badges={entry.badges} />
              </span>
            );
          }
          if (DATE_FIELDS.has(path)) {
            const date = dateOf(value);
            return date === undefined ? null : (
              <span className="tabular-nums">{dueText(date, now, locale, zone)}</span>
            );
          }
          if (path === 'priority') {
            return <PriorityChip priority={typeof value === 'number' ? value : null} />;
          }
          if (path === 'source.provider' && typeof value === 'string') {
            return <SourceDot source={value as Provider} showName />;
          }
          if (path === 'status' && typeof value === 'string') {
            return t(`dataBlocks.status.${value}`, { defaultValue: value });
          }
          if (path === 'kind' && typeof value === 'string') {
            return t(`dataBlocks.table.kinds.${value}`, { defaultValue: value });
          }
          if (path === 'topic') {
            return topicLabel(
              topics,
              typeof value === 'string' ? value : null,
              t('topics.unsorted'),
            );
          }
          return <CellText value={value} />;
        },
      });
    });
    const open = helper.display({
      id: 'open',
      header: () => <span className="sr-only">{t('items.openSource')}</span>,
      enableSorting: false,
      cell: (info) => (
        <SourceLink
          source={info.row.original.row.source}
          title={truncateText(info.row.original.row.title, 160)}
        />
      ),
    });
    return [...dataColumns, open];
  }, [paths, t, now, locale, zone, openItem, topics]);

  const table = useReactTable({
    data: rows,
    columns,
    state: { sorting },
    onSortingChange: setSorting,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getRowId: (entry) => entry.row.id,
  });

  const status = loadState !== 'ready' ? loadState : rows.length === 0 ? 'empty' : 'ready';

  return (
    <BlockFrame
      title={blockTitle(block, t)}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<Table2 />}
      emptyMessage={t('dataBlocks.table.empty')}
      className="[&>div]:px-0"
    >
      <table className="w-max min-w-full border-separate border-spacing-0 text-sm">
        <thead>
          {table.getHeaderGroups().map((group) => (
            <tr key={group.id}>
              {group.headers.map((header, index) => {
                const sorted = header.column.getIsSorted();
                const sortable = header.column.getCanSort();
                const label = String(header.column.columnDef.header);
                return (
                  <th
                    key={header.id}
                    scope="col"
                    aria-sort={
                      sorted === 'asc' ? 'ascending' : sorted === 'desc' ? 'descending' : undefined
                    }
                    className={cn(
                      'sticky top-0 z-10 border-b bg-card px-3 py-1.5 text-start text-xs font-medium whitespace-nowrap text-muted-foreground',
                      index === 0 && 'ps-4',
                    )}
                  >
                    {sortable ? (
                      <button
                        type="button"
                        onClick={header.column.getToggleSortingHandler()}
                        aria-label={t('dataBlocks.table.sortBy', { column: label })}
                        className="-mx-1 inline-flex min-h-8 items-center gap-1 rounded-sm px-1 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none"
                      >
                        {flexRender(header.column.columnDef.header, header.getContext())}
                        <SortIcon sorted={sorted} />
                      </button>
                    ) : (
                      flexRender(header.column.columnDef.header, header.getContext())
                    )}
                  </th>
                );
              })}
            </tr>
          ))}
        </thead>
        <tbody>
          {table.getRowModel().rows.map((row) => (
            <tr key={row.id} className="hover:bg-sunken/50">
              {row.getVisibleCells().map((cell, index) => (
                <td
                  key={cell.id}
                  className={cn(
                    'border-b px-3 py-1.5 align-middle whitespace-nowrap',
                    index === 0 && 'ps-4',
                    index === 0 &&
                      row.original.tone !== undefined &&
                      cn('border-s-2', TONE_CLASS[row.original.tone]),
                  )}
                >
                  {index === 0 && row.original.tone !== undefined ? (
                    <span className="sr-only">{t(`dataBlocks.tone.${row.original.tone}`)}. </span>
                  ) : null}
                  {flexRender(cell.column.columnDef.cell, cell.getContext())}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </BlockFrame>
  );
}
