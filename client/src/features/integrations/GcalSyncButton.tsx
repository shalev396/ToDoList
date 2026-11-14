import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarSync } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { useIntegrations, useIntegrationSyncRuns } from '@/api/queries/integrations';
import { gcalSync } from '@/api/services/integrationService';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { SyncStatus } from './SyncStatus';

interface Counts {
  create: number;
  update: number;
  remove: number;
}

function GcalSyncDialog({
  workspaceId,
  integrationId,
  onClose,
}: {
  workspaceId: string;
  integrationId: string;
  onClose: () => void;
}) {
  const { t } = useTranslation();
  const [counts, setCounts] = useState<Counts | null>(null);
  const [runId, setRunId] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const runs = useIntegrationSyncRuns(workspaceId);
  const run = runId === null ? undefined : runs.data?.find((entry) => entry.id === runId);

  // The dry run starts when the dialog opens.
  useEffect(() => {
    let live = true;
    gcalSync(workspaceId, { integrationId }, { suppressErrorToast: true })
      .then(({ data }) => {
        if (live && data.dryRun) {
          setCounts(data.counts);
        }
      })
      .catch((failure: unknown) => {
        if (live) {
          setError(errorMessage(t, failure, 'connect.gcalSync.failed'));
        }
      });
    return () => {
      live = false;
    };
  }, [workspaceId, integrationId, t]);

  const confirm = async () => {
    setBusy(true);
    setError(null);
    try {
      const { data } = await gcalSync(
        workspaceId,
        { integrationId, confirm: true },
        { suppressErrorToast: true },
      );
      if (!data.dryRun) {
        setRunId(data.runId);
      }
    } catch (failure) {
      setError(errorMessage(t, failure, 'connect.gcalSync.failed'));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="sm:max-w-md">
        <DialogHeader>
          <DialogTitle>{t('connect.gcalSync.title')}</DialogTitle>
          <DialogDescription>{t('connect.gcalSync.description')}</DialogDescription>
        </DialogHeader>
        {error === null ? null : (
          <p role="alert" data-gcal-sync-error className="text-sm text-destructive">
            {error}
          </p>
        )}
        {counts === null ? (
          error === null ? (
            <p role="status" className="text-sm text-muted-foreground">
              {t('connect.gcalSync.checking')}
            </p>
          ) : null
        ) : (
          <ul data-gcal-counts className="flex flex-col gap-1 text-sm">
            <li>{t('connect.gcalSync.create', { n: counts.create })}</li>
            <li>{t('connect.gcalSync.update', { n: counts.update })}</li>
            <li>{t('connect.gcalSync.remove', { n: counts.remove })}</li>
          </ul>
        )}
        {run === undefined ? null : <SyncStatus run={run} />}
        <DialogFooter>
          <Button type="button" variant="ghost" onClick={onClose}>
            {t(runId === null ? 'connect.cancel' : 'connect.done')}
          </Button>
          {runId === null ? (
            <Button type="button" disabled={counts === null || busy} onClick={() => void confirm()}>
              {t('connect.gcalSync.confirm')}
            </Button>
          ) : null}
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

/**
 * "Sync to calendar": a dry run with create, update and remove counts, then a confirmed run that
 * is polled through the sync runs. Editors and owners with a Google Calendar connected only.
 */
export function GcalSyncButton({ className }: { className?: string | undefined }) {
  const { t } = useTranslation();
  const { workspace, role } = useCurrentWorkspace();
  const workspaceId = workspace?.id ?? '';
  const integrations = useIntegrations(workspaceId);
  const [open, setOpen] = useState(false);
  const calendar = integrations.data?.find((entry) => entry.provider === 'google_calendar');
  const allowed = role === 'editor' || role === 'owner';
  const reason = !allowed
    ? t('blocks.action.notEditor')
    : calendar === undefined
      ? t('connect.gcalSync.notConnected')
      : null;
  return (
    <>
      <Button
        variant="outline"
        className={className}
        disabled={reason !== null}
        title={reason ?? undefined}
        data-gcal-sync
        onClick={() => {
          setOpen(true);
        }}
      >
        <CalendarSync aria-hidden="true" />
        {t('blocks.action.sync_gcal')}
      </Button>
      {open && calendar !== undefined ? (
        <GcalSyncDialog
          workspaceId={workspaceId}
          integrationId={calendar.id}
          onClose={() => {
            setOpen(false);
          }}
        />
      ) : null}
    </>
  );
}
