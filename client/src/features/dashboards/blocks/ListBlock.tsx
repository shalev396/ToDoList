import { Link } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { ArrowUpRight, List as ListIcon, Plus } from 'lucide-react';
import { useCompleteItem } from '@/api/queries/blockItems';
import { RoundCheckbox } from '@/components/items/RoundCheckbox';
import { TaskRow } from '@/components/items/TaskRow';
import { Button } from '@/components/ui/button';
import { buttonVariants } from '@/components/ui/button-variants';
import { useShellUi } from '@/features/shell/shellUi';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, topicPath } from '@/router/routes';
import { useItemParam } from '@/features/items/useItemParam';
import { CopyChips } from '@/features/items/CopyChips';
import { copiesOfProps } from '@/features/items/copies';
import { SourceLink } from '@/features/items/SourceLink';
import { topicById } from '@/features/workspaces/topics';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { ItemQueryRow } from '@api-types/builder';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';
import type { DisplayedRow } from '../rules/applyDisplayRules';
import { BadgeChips, PriorityChip, ShowAll, ToneRow } from './data/RowParts';
import { listAddTopic } from './data/listAdd';
import { displayProvider, dateOf } from './data/rows';
import { useDataBlock } from './data/useDataBlock';
import { truncateText } from './data/truncate';

const DEFAULT_VISIBLE = 7;
const MAX_TITLE = 160;

function visibleRowsOf(viz: Record<string, unknown>): number {
  const value = viz['visibleRows'];
  return typeof value === 'number' && value >= 1 ? Math.floor(value) : DEFAULT_VISIBLE;
}

function ListRows({
  rows,
  now,
  timeZone,
  linkToGroup,
}: {
  rows: readonly DisplayedRow<ItemQueryRow>[];
  now: Date;
  timeZone: string;
  linkToGroup: boolean;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const complete = useCompleteItem();
  const { openItem } = useItemParam();
  const { topics } = useCurrentWorkspace();

  return (
    <ul className="m-0 flex list-none flex-col p-0">
      {rows.map(({ row, tone, badges }) => {
        const local = row.source.provider === 'local';
        const done = row.status === 'done';
        const title = truncateText(row.title, MAX_TITLE) || t('dataBlocks.noTitle');
        // A group page lives under its topic's URL; an Unsorted row has none to open.
        const topicSlug = topicById(topics, row.topicId)?.slug ?? null;
        return (
          <li key={row.id} className="border-b last:border-b-0">
            <ToneRow tone={tone}>
              <TaskRow
                title={title}
                source={displayProvider(row.source.provider)}
                now={now}
                due={dateOf(row.dueAt)}
                timeZone={timeZone}
                done={done}
                onOpen={() => {
                  openItem(row.id);
                }}
                checkbox={
                  local ? (
                    <RoundCheckbox
                      checked={done}
                      label={t(done ? 'dataBlocks.list.markOpen' : 'dataBlocks.list.markDone', {
                        title,
                      })}
                      onCheckedChange={(checked) => {
                        complete(row.id, checked);
                      }}
                    />
                  ) : undefined
                }
                meta={
                  <>
                    <PriorityChip priority={row.priority} />
                    <BadgeChips badges={badges} />
                    <CopyChips copies={copiesOfProps(row.props)} />
                    {linkToGroup && row.containerId !== null && topicSlug !== null ? (
                      <Link
                        to={pathTo(topicPath(topicSlug, row.containerId), language)}
                        aria-label={t('dataBlocks.openGroup', { title })}
                        className={buttonVariants({ variant: 'ghost', size: 'icon-sm' })}
                      >
                        <ArrowUpRight aria-hidden="true" />
                      </Link>
                    ) : null}
                  </>
                }
                openIn={<SourceLink source={row.source} title={title} />}
              />
            </ToneRow>
          </li>
        );
      })}
    </ul>
  );
}

/** Todoist-style list (FRONTEND.md §5): checkbox for local to-dos only, priority and due chips. */
export default function ListBlock({ dashboard, block }: BlockComponentProps) {
  const { t } = useTranslation();
  const { query, rows, loadState, now, timeZone } = useDataBlock(dashboard, block);

  const { role } = useCurrentWorkspace();
  const { openNewTodoIn } = useShellUi();
  const addTopic = listAddTopic(block, dashboard.scope, role);
  const visible = visibleRowsOf(block.viz);
  const title = blockTitle(block, t);
  const status = loadState !== 'ready' ? loadState : rows.length === 0 ? 'empty' : 'ready';
  const linkToGroup = block.viz['linkTo'] === 'group';

  return (
    <BlockFrame
      title={title}
      status={status}
      onRetry={() => {
        void query.refetch();
      }}
      emptyIcon={<ListIcon />}
      emptyMessage={t('dataBlocks.list.empty')}
      actions={
        addTopic === null ? undefined : (
          <Button
            variant="ghost"
            size="sm"
            className="max-md:h-11"
            data-list-add
            onClick={() => {
              openNewTodoIn(addTopic);
            }}
          >
            <Plus aria-hidden="true" />
            {t('dataBlocks.list.add')}
          </Button>
        )
      }
      footer={
        rows.length > visible ? (
          <ShowAll title={title} count={rows.length}>
            <ListRows rows={rows} now={now} timeZone={timeZone} linkToGroup={linkToGroup} />
          </ShowAll>
        ) : undefined
      }
    >
      <ListRows
        rows={rows.slice(0, visible)}
        now={now}
        timeZone={timeZone}
        linkToGroup={linkToGroup}
      />
    </BlockFrame>
  );
}
