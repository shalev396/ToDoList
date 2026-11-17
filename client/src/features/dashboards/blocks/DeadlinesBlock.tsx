import { useId, useMemo } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarClock } from 'lucide-react';
import { DeadlineRow } from '@/components/items/DeadlineRow';
import { useItemParam } from '@/features/items/useItemParam';
import { SourceLink } from '@/features/items/SourceLink';
import type { ItemQueryRow } from '@api-types/builder';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';
import type { DisplayedRow } from '../rules/applyDisplayRules';
import { groupDeadlines } from './data/deadlineBuckets';
import { BadgeChips, ShowAll, ToneRow } from './data/RowParts';
import { displayProvider, dateOf, presetDays } from './data/rows';
import { truncateText } from './data/truncate';
import { useDataBlock } from './data/useDataBlock';

const MAX_VISIBLE = 7;

type Dated = DisplayedRow<ItemQueryRow> & { due: Date };

function DeadlineGroups({
  groups,
  now,
  timeZone,
}: {
  groups: { bucket: string; rows: Dated[] }[];
  now: Date;
  timeZone: string;
}) {
  const { t } = useTranslation();
  const prefix = useId();
  const { openItem } = useItemParam();
  return (
    <div className="flex flex-col gap-3">
      {groups.map((group) => {
        const label = t(`dataBlocks.deadlines.${group.bucket}`);
        return (
          <div key={group.bucket}>
            <h3
              id={`${prefix}-${group.bucket}`}
              className="pt-1 text-xs font-semibold tracking-wide text-muted-foreground uppercase"
            >
              {label}
            </h3>
            <ul aria-labelledby={`${prefix}-${group.bucket}`} className="m-0 list-none p-0">
              {group.rows.map(({ row, tone, badges, due }) => {
                const title = truncateText(row.title, 160) || t('dataBlocks.noTitle');
                return (
                  <li key={row.id} className="border-b last:border-b-0">
                    <ToneRow tone={tone}>
                      <DeadlineRow
                        title={title}
                        source={displayProvider(row.source.provider)}
                        due={due}
                        now={now}
                        timeZone={timeZone}
                        done={row.status === 'done'}
                        showSource
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
              })}
            </ul>
          </div>
        );
      })}
    </div>
  );
}

/**
 * Deadlines (FRONTEND.md §5): grouped Overdue / Today / This week / Later by calendar day in the
 * workspace's time zone, overdue first, then soonest. Rows without a due date are left out.
 */
export default function DeadlinesBlock({ dashboard, block }: BlockComponentProps) {
  const { t } = useTranslation();
  const { query, rows, loadState, now, timeZone, weekStart } = useDataBlock(dashboard, block);
  const title = blockTitle(block, t);

  const dated = useMemo(
    () =>
      rows.flatMap((entry): Dated[] => {
        const due = dateOf(entry.row.dueAt);
        return due === undefined ? [] : [{ ...entry, due }];
      }),
    [rows],
  );
  const groups = useMemo(
    () => groupDeadlines(dated, (entry) => entry.due, now, timeZone, weekStart),
    [dated, now, timeZone, weekStart],
  );
  // The first MAX_VISIBLE rows in group order; "Show all" has the rest.
  const visibleGroups = useMemo(() => {
    const visible: typeof groups = [];
    let left = MAX_VISIBLE;
    for (const group of groups) {
      if (left <= 0) {
        break;
      }
      const slice = group.rows.slice(0, left);
      left -= slice.length;
      visible.push({ bucket: group.bucket, rows: slice });
    }
    return visible;
  }, [groups]);

  const days = presetDays(block.query?.dateRange);
  const emptyMessage =
    days === undefined
      ? t('dataBlocks.deadlines.empty')
      : t('dataBlocks.deadlines.emptyDays', { count: days });
  const status = loadState !== 'ready' ? loadState : dated.length === 0 ? 'empty' : 'ready';

  return (
    <BlockFrame
      title={title}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<CalendarClock />}
      emptyMessage={emptyMessage}
      footer={
        dated.length > MAX_VISIBLE ? (
          <ShowAll title={title} count={dated.length}>
            <DeadlineGroups groups={groups} now={now} timeZone={timeZone} />
          </ShowAll>
        ) : undefined
      }
    >
      <DeadlineGroups groups={visibleGroups} now={now} timeZone={timeZone} />
    </BlockFrame>
  );
}
