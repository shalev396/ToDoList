import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { runQuery } from '@/api/services/queryService';
import { TaskRow } from '@/components/items/TaskRow';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { Skeleton } from '@/components/ui/skeleton';
import { SourceLink } from '@/features/items/SourceLink';
import { workspaceKey } from '@/features/workspaces/switching';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { Block, Query } from '@api-types/builder';
import type { DashboardView } from '@api-types/dashboards';
import { selectBlockVars, varsHash } from '../variables/blockVars';
import type { PageVars } from '../variables/urlVars';
import { drillQuery } from './data/drillQuery';
import { displayProvider, dateOf, itemRowsOf } from './data/rows';
import { truncateText } from './data/truncate';
import { ScrollArea } from '@/components/ui/scroll-area';

export interface DrillTarget {
  field: string;
  key: string;
  /** The group's real value (not its label), for the drill rule. */
  value: string | number | boolean;
  name: string;
}

/** The items behind one chart segment, in a right Sheet (a bottom-up drawer is the sheet's own on phones). */
export function ChartDrillSheet({
  dashboard,
  block,
  query,
  vars,
  target,
  now,
  timeZone,
  onClose,
}: {
  dashboard: DashboardView;
  block: Block;
  query: Query;
  vars: PageVars;
  target: DrillTarget | null;
  now: Date;
  timeZone: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const { workspace } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? null;
  const selected = selectBlockVars(block, vars);

  const result = useQuery({
    queryKey: workspaceKey(
      workspaceId ?? '',
      'block',
      dashboard.id,
      block.id,
      'drill',
      target?.field ?? '',
      target?.key ?? '',
      varsHash(selected),
    ),
    enabled: target !== null && workspaceId !== null,
    queryFn: async ({ signal }) => {
      if (target === null || workspaceId === null) {
        throw new Error('No segment');
      }
      const response = await runQuery(
        workspaceId,
        {
          draft: drillQuery(query, target.field, target.value),
          blockType: 'chart',
          vars: selected,
          preview: true,
        },
        { signal, suppressErrorToast: true },
      );
      return response.data;
    },
  });
  const rows = itemRowsOf(result.data);

  return (
    <Sheet
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <SheetContent
        aria-describedby={undefined}
        closeLabel={t('dataBlocks.close')}
        className="w-[min(32rem,100vw)] sm:max-w-lg"
      >
        <SheetHeader>
          <SheetTitle className="truncate pe-10" title={target?.name}>
            {target?.name}
          </SheetTitle>
          <p className="text-[13px] text-muted-foreground">
            {t('dataBlocks.chart.drillCount', { count: result.data?.total ?? 0 })}
          </p>
        </SheetHeader>
        <ScrollArea focusable className="min-h-0 flex-1">
          <div className="px-4 pb-4">
            {result.isLoading ? (
              <div role="status" className="flex flex-col gap-3">
                <Skeleton className="h-4 w-full" />
                <Skeleton className="h-4 w-3/4" />
              </div>
            ) : rows.length === 0 ? (
              <p className="text-[13px] text-muted-foreground">
                {t('dataBlocks.chart.drillEmpty')}
              </p>
            ) : (
              <ul className="m-0 list-none p-0">
                {rows.map((row) => {
                  const title = truncateText(row.title, 160) || t('dataBlocks.noTitle');
                  return (
                    <li key={row.id} className="border-b last:border-b-0">
                      <TaskRow
                        title={title}
                        source={displayProvider(row.source.provider)}
                        now={now}
                        due={dateOf(row.dueAt)}
                        timeZone={timeZone}
                        done={row.status === 'done'}
                        openIn={<SourceLink source={row.source} title={title} />}
                      />
                    </li>
                  );
                })}
              </ul>
            )}
          </div>
        </ScrollArea>
      </SheetContent>
    </Sheet>
  );
}
