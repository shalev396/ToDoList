import { useMemo, useState, useSyncExternalStore } from 'react';
import { useTranslation } from 'react-i18next';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Cell,
  Line,
  LineChart,
  Pie,
  PieChart,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';
import { ChartPie } from 'lucide-react';
import { dateLocale } from '@/components/items/format';
import { sourceNameKey } from '@/components/items/sources';
import { Popover, PopoverContent, PopoverTrigger } from '@/components/ui/popover';
import { ScrollArea } from '@/components/ui/scroll-area';
import { cn } from '@/lib/utils';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';
import { varNameOf } from '../variables/names';
import { ChartDrillSheet, type DrillTarget } from './ChartDrillSheet';
import { segmentsTotal, toSegments, type Segment } from './data/chartData';
import { useDataBlock } from './data/useDataBlock';
import { topicLabel } from '@/features/workspaces/topics';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { usePageVars } from '../variables/pageVars';

const SLOT_COUNT = 7;

/** Source colours by provider (colour follows the source); anything else takes the slots in order. */
function segmentColor(segment: Segment, index: number): string {
  if (segment.provider !== undefined) {
    return `var(--color-source-${segment.provider.replaceAll('_', '-')})`;
  }
  return `var(--chart-${String((index % SLOT_COUNT) + 1)})`;
}

const reducedQuery = '(prefers-reduced-motion: reduce)';
function subscribeMotion(onChange: () => void): () => void {
  const media = window.matchMedia(reducedQuery);
  media.addEventListener('change', onChange);
  return () => {
    media.removeEventListener('change', onChange);
  };
}
function useReducedMotion(): boolean {
  return useSyncExternalStore(
    subscribeMotion,
    () => window.matchMedia(reducedQuery).matches,
    () => false,
  );
}

interface Datum {
  name: string;
  value: number;
  fill: string;
  key: string;
}

function ChartTooltip({
  active,
  payload,
}: {
  active?: boolean | undefined;
  payload?: readonly { payload?: Datum }[] | undefined;
}) {
  const { t } = useTranslation();
  const datum = payload?.[0]?.payload;
  if (active !== true || datum === undefined) {
    return null;
  }
  return (
    <div className="flex items-center gap-2 rounded-md border bg-popover px-2.5 py-1.5 text-xs text-popover-foreground shadow-(--shadow-overlay)">
      <span aria-hidden="true" className="size-2 rounded-full" style={{ background: datum.fill }} />
      {t('dataBlocks.chart.segment', { name: datum.name, count: datum.value })}
    </div>
  );
}

/**
 * Chart (FRONTEND.md §5): donut, bar, line or a single number from a groupBy + count query.
 * Source colours, one axis, thin marks. The legend chips are buttons: one sets the block's
 * `emits.onSegmentClick` variable and opens the segment's items in a Sheet. A visually hidden
 * table carries the same numbers for screen readers.
 */
/** Legend chips shown inline; the rest sit behind a "+N more" chip. */
const LEGEND_VISIBLE = 6;

export default function ChartBlock({ dashboard, block }: BlockComponentProps) {
  const { t, i18n } = useTranslation();
  const { topics } = useCurrentWorkspace();
  const { query, loadState, now, timeZone, vars } = useDataBlock(dashboard, block);
  const { setVar, clearVar, bound } = usePageVars();
  const reducedMotion = useReducedMotion();
  const [drill, setDrill] = useState<DrillTarget | null>(null);
  const locale = dateLocale(i18n.language);
  const kind = typeof block.viz['kind'] === 'string' ? block.viz['kind'] : 'donut';
  const legend =
    block.viz['legend'] === 'list' || block.viz['legend'] === 'none'
      ? block.viz['legend']
      : 'chips';
  const showTotal = block.viz['showTotal'] !== false;
  const title = blockTitle(block, t);
  const emitted = block.emits?.onSegmentClick;
  const emitName = emitted === undefined ? null : varNameOf(emitted);

  const segments = useMemo(() => toSegments(query.data?.groups ?? []), [query.data]);
  const total = segmentsTotal(segments);

  const nameOf = (segment: Segment): string => {
    if (segment.key === '') {
      return t('dataBlocks.chart.unknown');
    }
    if (segment.provider !== undefined) {
      return t(sourceNameKey(segment.provider));
    }
    if (segment.field === 'status') {
      return t(`dataBlocks.status.${segment.key}`, { defaultValue: segment.key });
    }
    if (segment.field === 'topic') {
      return topicLabel(topics, segment.key, t('topics.unsorted'));
    }
    if (segment.field === 'kind') {
      return t(`dataBlocks.table.kinds.${segment.key}`, { defaultValue: segment.key });
    }
    return segment.key;
  };
  const data: Datum[] = segments.map((segment, index) => ({
    name: nameOf(segment),
    value: segment.value,
    fill: segmentColor(segment, index),
    key: segment.key,
  }));

  const status = loadState !== 'ready' ? loadState : segments.length === 0 ? 'empty' : 'ready';
  const format = new Intl.NumberFormat(locale);

  const choose = (segment: Segment, name: string) => {
    const active = emitName !== null && vars[emitName] === segment.key;
    if (emitName !== null && !bound.has(emitName)) {
      if (active) {
        clearVar(emitName);
      } else {
        setVar(emitName, segment.key);
      }
    }
    if (!active && segment.key !== '' && block.query !== undefined) {
      setDrill({ field: segment.field, key: segment.key, name });
    }
  };

  const plot = (() => {
    if (kind === 'number') {
      return (
        <p className="flex h-full flex-col items-center justify-center">
          <span className="text-4xl leading-none font-semibold tabular-nums">
            {format.format(total)}
          </span>
          <span className="mt-1.5 text-[13px] text-muted-foreground">
            {t('dataBlocks.chart.total')}
          </span>
        </p>
      );
    }
    if (kind === 'bar') {
      return (
        <ResponsiveContainer width="100%" height="100%" minHeight={96}>
          <BarChart data={data} margin={{ top: 8, right: 4, bottom: 0, left: 4 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="name"
              tickLine={false}
              axisLine={false}
              interval={0}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            />
            <YAxis hide />
            <Tooltip cursor={false} content={<ChartTooltip />} />
            <Bar
              dataKey="value"
              maxBarSize={28}
              radius={[4, 4, 0, 0]}
              isAnimationActive={!reducedMotion}
            >
              {data.map((datum) => (
                <Cell key={datum.key} fill={datum.fill} stroke="var(--card)" strokeWidth={2} />
              ))}
            </Bar>
          </BarChart>
        </ResponsiveContainer>
      );
    }
    if (kind === 'line') {
      return (
        <ResponsiveContainer width="100%" height="100%" minHeight={96}>
          <LineChart data={data} margin={{ top: 8, right: 12, bottom: 0, left: 12 }}>
            <CartesianGrid vertical={false} stroke="var(--border)" />
            <XAxis
              dataKey="name"
              tickLine={false}
              axisLine={false}
              tick={{ fontSize: 11, fill: 'var(--muted-foreground)' }}
            />
            <YAxis hide />
            <Tooltip content={<ChartTooltip />} />
            <Line
              dataKey="value"
              type="monotone"
              stroke="var(--chart-1)"
              strokeWidth={2}
              isAnimationActive={!reducedMotion}
              dot={{ r: 4, fill: 'var(--chart-1)', stroke: 'var(--card)', strokeWidth: 2 }}
              activeDot={{ r: 5, stroke: 'var(--card)', strokeWidth: 2 }}
            />
          </LineChart>
        </ResponsiveContainer>
      );
    }
    return (
      <div className="relative h-full min-h-24">
        <ResponsiveContainer width="100%" height="100%" minHeight={96}>
          <PieChart>
            <Tooltip content={<ChartTooltip />} />
            <Pie
              data={data}
              dataKey="value"
              nameKey="name"
              innerRadius="62%"
              outerRadius="92%"
              paddingAngle={0}
              stroke="var(--card)"
              strokeWidth={2}
              startAngle={90}
              endAngle={-270}
              isAnimationActive={!reducedMotion}
            >
              {data.map((datum) => (
                <Cell key={datum.key} fill={datum.fill} />
              ))}
            </Pie>
          </PieChart>
        </ResponsiveContainer>
        {showTotal ? (
          <p className="pointer-events-none absolute inset-0 flex flex-col items-center justify-center">
            <span className="text-2xl leading-none font-semibold tabular-nums">
              {format.format(total)}
            </span>
            <span className="mt-1 text-xs text-muted-foreground">
              {t('dataBlocks.chart.total')}
            </span>
          </p>
        ) : null}
      </div>
    );
  })();

  const renderChip = (segment: (typeof segments)[number], index: number, row = false) => {
    const name = data[index]?.name ?? segment.key;
    const pressed = emitName !== null && vars[emitName] === segment.key;
    return (
      <button
        type="button"
        aria-pressed={emitName === null ? undefined : pressed}
        aria-label={t('dataBlocks.chart.filterBy', { name })}
        onClick={() => {
          choose(segment, name);
        }}
        className={cn(
          'inline-flex min-h-8 items-center gap-1.5 text-xs text-foreground transition-colors hover:bg-sunken focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11',
          row ? 'w-full rounded-sm px-2' : 'rounded-full border px-2.5',
          pressed && 'bg-sunken font-medium',
        )}
      >
        <span
          aria-hidden="true"
          className="size-2 shrink-0 rounded-full"
          style={{ background: segmentColor(segment, index) }}
        />
        <span className={cn('truncate', row ? 'min-w-0 flex-1 text-start' : 'max-w-28')}>
          {name}
        </span>
        <span className="tabular-nums text-muted-foreground">{format.format(segment.value)}</span>
      </button>
    );
  };

  return (
    <BlockFrame
      title={title}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<ChartPie />}
      emptyMessage={t('dataBlocks.chart.empty')}
    >
      <div className="flex h-full min-h-0 flex-col gap-2">
        <div
          role="img"
          aria-label={`${title}: ${data.map((d) => t('dataBlocks.chart.segment', { name: d.name, count: d.value })).join(', ')}`}
          className="min-h-0 flex-1"
        >
          {plot}
        </div>
        {legend === 'none' ? null : (
          <ul
            aria-label={t('dataBlocks.chart.legend')}
            className={cn(
              'm-0 flex list-none gap-1.5 p-0',
              legend === 'list' ? 'flex-col' : 'flex-wrap',
            )}
          >
            {segments.slice(0, LEGEND_VISIBLE).map((segment, index) => (
              <li key={segment.key}>{renderChip(segment, index)}</li>
            ))}
            {segments.length > LEGEND_VISIBLE ? (
              <li>
                <Popover>
                  <PopoverTrigger
                    className="inline-flex min-h-8 items-center rounded-full border px-2.5 text-xs text-muted-foreground transition-colors hover:bg-sunken hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none pointer-coarse:min-h-11"
                    aria-label={t('dataBlocks.chart.legendMoreLabel', {
                      count: segments.length - LEGEND_VISIBLE,
                    })}
                  >
                    {t('dataBlocks.chart.legendMore', { count: segments.length - LEGEND_VISIBLE })}
                  </PopoverTrigger>
                  <PopoverContent align="start" className="w-64 p-1">
                    <ScrollArea className="max-h-64" viewportClassName="max-h-[inherit]">
                      <ul aria-label={t('dataBlocks.chart.legend')} className="m-0 list-none p-0">
                        {segments.map((segment, index) => (
                          <li key={segment.key}>{renderChip(segment, index, true)}</li>
                        ))}
                      </ul>
                    </ScrollArea>
                  </PopoverContent>
                </Popover>
              </li>
            ) : null}
          </ul>
        )}
        <table className="sr-only">
          <caption>{t('dataBlocks.chart.dataTable', { title })}</caption>
          <thead>
            <tr>
              <th scope="col">{t('dataBlocks.chart.colName')}</th>
              <th scope="col">{t('dataBlocks.chart.colCount')}</th>
            </tr>
          </thead>
          <tbody>
            {data.map((datum) => (
              <tr key={datum.key}>
                <th scope="row">{datum.name}</th>
                <td>{datum.value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      </div>
      {block.query === undefined ? null : (
        <ChartDrillSheet
          dashboard={dashboard}
          block={block}
          query={block.query}
          vars={vars}
          target={drill}
          now={now}
          timeZone={timeZone}
          onClose={() => {
            setDrill(null);
          }}
        />
      )}
    </BlockFrame>
  );
}
