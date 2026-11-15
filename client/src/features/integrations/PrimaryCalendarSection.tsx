import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CalendarDays, CircleAlert } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import {
  useClearPrimaryCalendar,
  useGoogleCalendars,
  useIntegrations,
  usePrimaryCalendar,
} from '@/api/queries/integrations';
import {
  AlertDialog,
  AlertDialogAction,
  AlertDialogCancel,
  AlertDialogContent,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogTitle,
} from '@/components/ui/alert-dialog';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import type { PrimaryCalendarView } from '@api-types/api-contracts';
import { CleanupNote, RemoveOldCheckbox } from './CleanupNote';
import { PrimaryCalendarPicker } from './PrimaryCalendarPicker';
import { ShareCalendarDialog } from './ShareCalendarDialog';
import { useRemovableOldPrimary, useRemovePushed } from './useRemovePushed';

/** The calendar's name from the account's calendars; its id until they load. */
function useCalendarName(workspaceId: string, view: PrimaryCalendarView): string {
  const calendars = useGoogleCalendars(workspaceId, view.integrationId ?? '');
  const id = view.calendarId ?? '';
  return calendars.data?.find((entry) => entry.id === id)?.summary ?? id;
}

/** Only for the calendar's owner: its name and the Share button. */
function MineActive({
  workspaceId,
  view,
  onShare,
}: {
  workspaceId: string;
  view: PrimaryCalendarView;
  onShare: () => void;
}) {
  const { t } = useTranslation();
  const name = useCalendarName(workspaceId, view);
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
      <p data-primary-name className="min-w-0 text-sm break-all" dir="auto">
        {t('connect.primary.activeMine', { name })}
      </p>
      <Button type="button" size="sm" variant="outline" className="max-md:h-11" onClick={onShare}>
        {t('connect.primary.share')}
      </Button>
    </div>
  );
}

/**
 * The workspace calendar: the one Google calendar dated to-dos are sent to. Everyone sees its
 * state; the workspace owner chooses it, changes it or stops sending; the connection's owner can
 * share it.
 */
export function PrimaryCalendarSection({ workspaceId }: { workspaceId: string }) {
  const { t } = useTranslation();
  const { role } = useCurrentWorkspace();
  const primary = usePrimaryCalendar(workspaceId);
  const clear = useClearPrimaryCalendar(workspaceId);
  const [picking, setPicking] = useState(false);
  const [sharing, setSharing] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [problem, setProblem] = useState<string | null>(null);
  const [removeOld, setRemoveOld] = useState(false);
  const [cleanedId, setCleanedId] = useState<string | null>(null);
  const integrations = useIntegrations(workspaceId);
  const oldIntegrationId = useRemovableOldPrimary(workspaceId);
  const cleanup = useRemovePushed(workspaceId);
  const isOwner = role === 'owner';
  const view = primary.data;

  const stop = async () => {
    setProblem(null);
    // The calendar being left: read before the stop, since the stop clears the workspace calendar.
    const leaving = removeOld ? oldIntegrationId : null;
    try {
      await clear.mutateAsync();
    } catch (failure) {
      setProblem(errorMessage(t, failure, 'connect.primary.stopFailed'));
      return;
    }
    if (leaving !== null) {
      setCleanedId(leaving);
      await cleanup.run(leaving);
    }
  };

  return (
    <section
      data-primary-calendar
      data-state={view?.state}
      aria-label={t('connect.primary.title')}
      className="mb-6 flex flex-col gap-3 rounded-lg border bg-card px-4 py-3"
    >
      <div className="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
        <div className="flex min-w-0 flex-1 basis-64 flex-col gap-1">
          <h2 className="flex items-center gap-2 text-sm font-semibold">
            <CalendarDays className="size-4" aria-hidden="true" />
            {t('connect.primary.title')}
          </h2>
          {view === undefined ? (
            primary.isError ? (
              <p role="alert" className="text-sm text-destructive">
                {t('connect.primary.loadFailed')}
              </p>
            ) : (
              <Skeleton className="h-5 w-2/3" aria-busy="true" />
            )
          ) : view.state === 'unset' ? (
            <p data-primary-unset className="text-sm text-muted-foreground">
              {t('connect.primary.unset')}
            </p>
          ) : view.state === 'active' ? (
            view.mine && view.integrationId !== null && view.calendarId !== null ? (
              <MineActive
                workspaceId={workspaceId}
                view={view}
                onShare={() => {
                  setSharing(true);
                }}
              />
            ) : (
              <p className="text-sm text-muted-foreground">{t('connect.primary.activeOther')}</p>
            )
          ) : null}
        </div>
        {view === undefined ? null : isOwner ? (
          <div className="flex flex-wrap items-center gap-2">
            <Button
              type="button"
              size="sm"
              variant="outline"
              className="max-md:h-11"
              data-primary-choose
              onClick={() => {
                setPicking(true);
              }}
            >
              {t(view.state === 'unset' ? 'connect.primary.choose' : 'connect.primary.change')}
            </Button>
            {view.state === 'unset' ? null : (
              <Button
                type="button"
                size="sm"
                variant="ghost"
                className="text-destructive max-md:h-11"
                disabled={clear.isPending}
                onClick={() => {
                  setConfirmingStop(true);
                }}
              >
                {t('connect.primary.stop')}
              </Button>
            )}
          </div>
        ) : (
          <p data-primary-by-owner className="text-[13px] text-muted-foreground">
            {t('connect.primary.setByOwner')}
          </p>
        )}
      </div>
      {view?.state === 'suspended' && !isOwner && !view.mine ? (
        <p role="status" data-primary-paused className="text-sm text-muted-foreground">
          {t('connect.primary.pausedOther')}
        </p>
      ) : null}
      {view?.state === 'suspended' && (isOwner || view.mine) ? (
        <p
          role="status"
          data-primary-suspended={view.reason ?? ''}
          className="flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>
            {t(
              view.reason === 'disconnected'
                ? 'connect.primary.suspendedDisconnected'
                : 'connect.primary.suspendedReadOnly',
            )}
          </span>
        </p>
      ) : null}
      {problem === null ? null : (
        <p role="alert" className="text-sm text-destructive">
          {problem}
        </p>
      )}

      {picking ? (
        <PrimaryCalendarPicker
          workspaceId={workspaceId}
          onClose={() => {
            setPicking(false);
          }}
        />
      ) : null}
      {cleanedId === null ? null : (
        <CleanupNote
          outcome={cleanup.outcome}
          pending={cleanup.pending}
          onContinue={() => {
            void cleanup.run(cleanedId);
          }}
        />
      )}
      {sharing && view?.calendarId !== undefined && view.calendarId !== null ? (
        <ShareCalendarDialog
          calendarId={view.calendarId}
          accountEmail={
            integrations.data?.find((entry) => entry.id === view.integrationId)?.accountLabel
          }
          onClose={() => {
            setSharing(false);
          }}
        />
      ) : null}
      <AlertDialog
        open={confirmingStop}
        onOpenChange={(open) => {
          setConfirmingStop(open);
          setRemoveOld(false);
        }}
      >
        <AlertDialogContent data-primary-stop-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connect.primary.stopTitle')}</AlertDialogTitle>
            <AlertDialogDescription>{t('connect.primary.stopBody')}</AlertDialogDescription>
            {oldIntegrationId === null ? null : (
              <RemoveOldCheckbox
                id="primary-stop-remove-old"
                checked={removeOld}
                onChange={setRemoveOld}
              />
            )}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connect.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void stop();
              }}
            >
              {t('connect.primary.stop')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </section>
  );
}
