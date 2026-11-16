import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink, RefreshCw } from 'lucide-react';
import { apiErrorStatus, errorMessage } from '@/api/errors';
import { useItem, useSyncNow, useSyncRuns } from '@/api/queries/items';
import { buttonVariants } from '@/components/ui/button-variants';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useItemParam } from '@/features/items/useItemParam';
import { BlockFrame } from '../BlockFrame';
import { blockTitle } from '../chrome';
import type { BlockComponentProps } from '../registry/types';
import { GcalSyncButton } from '@/features/integrations/GcalSyncButton';
import { syncOutcome } from './action/syncState';

/**
 * The action block: one button for one of the catalog's actions (`block.action`). The backend
 * runs them, never a query. "Sync now" queues a sync (202) and polls the run history every 3 s
 * while it runs. "Sync to calendar" needs the calendar bridge, which is not built yet, so it
 * shows its disabled state with the reason. "Open in provider" opens the source of the open item.
 */
export default function ActionBlock({ block }: BlockComponentProps) {
  const { t } = useTranslation();
  const title = blockTitle(block, t);
  const action = block.action ?? 'refresh_source';
  return (
    <BlockFrame title={title}>
      <div className="flex min-h-0 items-center gap-3">
        {action === 'refresh_source' ? (
          <SyncNow />
        ) : action === 'open_source' ? (
          <OpenSource />
        ) : (
          <SyncToCalendar />
        )}
      </div>
    </BlockFrame>
  );
}

/** 28px in a compact block; 44px where the pointer is a finger (DESIGN: tap targets). */
const BUTTON_CLASS = 'h-7 shrink-0 px-3 pointer-coarse:h-11';
const NOTE_CLASS = 'min-w-0 flex-1 text-[13px] leading-[14px] text-muted-foreground line-clamp-2';

function SyncNow() {
  const { t } = useTranslation();
  const noteId = useId();
  const { workspace, role } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? '';
  const canRun = role === 'editor' || role === 'owner';
  const [runIds, setRunIds] = useState<string[] | null>(null);
  const sync = useSyncNow(workspaceId);
  const [polling, setPolling] = useState(false);
  const runs = useSyncRuns(runIds === null ? null : workspaceId, polling);
  const outcome = runIds === null ? null : syncOutcome(runIds, runs.data ?? []);
  const running = sync.isPending || outcome === 'running';
  // Poll the history every 3 s only while a sync this block started is unfinished.
  const shouldPoll = outcome === 'running';
  if (shouldPoll !== polling) {
    setPolling(shouldPoll);
  }

  const status = sync.isError
    ? errorMessage(t, sync.error, 'blocks.action.failed')
    : outcome === 'none'
      ? t('blocks.action.nothingToSync')
      : outcome === 'running'
        ? t('blocks.action.syncing')
        : outcome === 'succeeded'
          ? t('blocks.action.synced')
          : outcome === 'partial'
            ? t('blocks.action.partial')
            : outcome === 'failed'
              ? t('blocks.action.failed')
              : '';

  return (
    <>
      <Button
        variant="outline"
        className={BUTTON_CLASS}
        disabled={!canRun || running}
        aria-describedby={canRun ? undefined : noteId}
        onClick={() => {
          sync.mutate(undefined, {
            onSuccess: (data) => {
              setRunIds(data.runIds);
            },
          });
        }}
      >
        <RefreshCw
          aria-hidden="true"
          className={cn(running && 'animate-spin motion-reduce:animate-none')}
        />
        {t('blocks.action.refresh_source')}
      </Button>
      <p
        id={noteId}
        role="status"
        className={NOTE_CLASS}
        data-sync-status={apiErrorStatus(sync.error) ?? outcome ?? ''}
      >
        {canRun ? status : t('blocks.action.notEditor')}
      </p>
    </>
  );
}

function OpenSource() {
  const { t } = useTranslation();
  const noteId = useId();
  const { workspace } = useCurrentWorkspace();
  const { id } = useItemParam();
  const item = useItem(workspace?.id ?? null, id);
  const openIn = item.data?.openIn;
  return (
    <>
      {openIn === undefined ? (
        <Button variant="outline" className={BUTTON_CLASS} disabled aria-describedby={noteId}>
          <ExternalLink aria-hidden="true" />
          {t('blocks.action.open_source')}
        </Button>
      ) : (
        <a
          href={openIn.url}
          target="_blank"
          rel="noopener noreferrer"
          className={cn(buttonVariants({ variant: 'outline' }), BUTTON_CLASS)}
        >
          <ExternalLink aria-hidden="true" />
          {t('blocks.action.open_source')}
        </a>
      )}
      {openIn === undefined ? (
        <p id={noteId} className={NOTE_CLASS}>
          {t('blocks.action.openNone')}
        </p>
      ) : null}
    </>
  );
}

/** The calendar push: a dry-run dialog with counts, then a confirmed run (GcalSyncButton). */
function SyncToCalendar() {
  return <GcalSyncButton className={BUTTON_CLASS} />;
}
