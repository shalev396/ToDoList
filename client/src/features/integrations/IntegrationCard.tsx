import { useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import type { CleanupProgress } from '@api-types/primaryCalendar.ts';
import {
  useDisconnectIntegration,
  usePrimaryCalendar,
  useStopSharing,
  useUpdateIntegration,
  useSyncIntegration,
  useTestIntegration,
} from '@/api/queries/integrations';
import { dateLocale } from '@/components/items/format';
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
import { Checkbox } from '@/components/ui/checkbox';
import { Switch } from '@/components/ui/switch';
import { useLanguage } from '@/hooks/useLanguage';
import { cn } from '@/lib/utils';
import { integrationAnchor } from './anchor';
import type { IntegrationStatusView } from '@api-types/api-contracts';
import type { IntegrationMode } from '@api-types/domain';
import type {
  ConnectableProvider,
  IntegrationTestResult,
  ProviderCapabilities,
  SyncRunView,
} from '@api-types/integrations';
import { hasResourcePicker, revokePageOf, revokesOnDisconnect, isOAuthSignIn } from './oauthSetup';
import { FileUnder } from './FileUnder';
import { finishProgress } from './cleanupLoop';
import { CleanupNote, CleanupProgressLine, CleanupRunning } from './CleanupNote';
import { daysUntil, needsRenewalHint } from './status';
import { SyncStatus } from './SyncStatus';
import { shouldOfferReconnect } from './providerSummary';
import { useCleanupRunner, useRemovePushed } from './useRemovePushed';

interface IntegrationCardProps {
  workspaceId: string;
  provider: ConnectableProvider;
  integration: IntegrationStatusView;
  /** It is on some block, so the whole workspace sees its items (GET …/integrations/sharing). */
  shared: boolean;
  run?: SyncRunView | undefined;
  timeZone: string;
  now: Date;
  onReplace: (integration: IntegrationStatusView) => void;
  /** A Google Calendar connected with Google: its calendar picker. */
  onCalendars?: ((integration: IntegrationStatusView) => void) | undefined;
  /** A connection made with OAuth: sign in again (same account). */
  onReconnect?: ((integration: IntegrationStatusView) => void) | undefined;
  /** What the server says this provider can do; undefined until the providers answer arrives. */
  capabilities?: ProviderCapabilities | undefined;
  /** What this stage can do about signing in, and the actions it leads to. */
  signIn: {
    /** Jira sites or ClickUp workspaces of a connected grant. */
    onResources: (integration: IntegrationStatusView) => void;
    /** GitHub: where the user installs the app on more repositories or organizations. */
    installUrl: string | null;
  };
}

/**
 * One connection, inside its provider's Manage panel: exactly the status shape (provider, account label, status, `expiresAt` with a
 * renewal hint 14 days ahead, `lastSyncAt`) and the sync run's counts. Never a token, a masked
 * hint or the last four characters.
 */
export function IntegrationCard({
  workspaceId,
  provider,
  integration,
  shared,
  run,
  timeZone,
  now,
  onReplace,
  onCalendars,
  onReconnect,
  capabilities,
  signIn,
}: IntegrationCardProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [test, setTest] = useState<IntegrationTestResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [confirmingWrite, setConfirmingWrite] = useState(false);
  const [reconnectOffer, setReconnectOffer] = useState(false);
  const [removeAdded, setRemoveAdded] = useState(false);
  const [disconnectProgress, setDisconnectProgress] = useState<CleanupProgress | null>(null);
  const primary = usePrimaryCalendar(workspaceId);
  const leftover = useRemovePushed(workspaceId);
  const disconnectCleanup = useCleanupRunner();
  const [confirmingRemove, setConfirmingRemove] = useState(false);
  const testConnection = useTestIntegration(workspaceId);
  const syncNow = useSyncIntegration(workspaceId);
  const disconnect = useDisconnectIntegration(workspaceId);
  const stopSharing = useStopSharing(workspaceId);
  const update = useUpdateIntegration(workspaceId);
  const name = t(`sources.${provider}`);
  // The item sheet links here (`#integration-<id>`) to switch the mode: the card comes into view
  // with its mode switch focused, once it has loaded.
  const { hash } = useLocation();
  const card = useRef<HTMLElement>(null);
  const anchor = integrationAnchor(integration.id);
  // The card the link named is marked (a mouse click gives programmatic focus no visible ring).
  const named = hash === `#${anchor}`;
  useEffect(() => {
    if (hash !== `#${anchor}`) {
      return;
    }
    card.current?.scrollIntoView({ block: 'center' });
    const target = card.current?.querySelector<HTMLElement>('[data-mode-switch]') ?? card.current;
    target?.focus({ preventScroll: true });
  }, [anchor, hash]);
  const format = (value: string | Date) =>
    new Intl.DateTimeFormat(dateLocale(language), {
      dateStyle: 'medium',
      timeStyle: 'short',
      timeZone,
    }).format(new Date(value));
  const dateOnly = (value: string | Date) =>
    new Intl.DateTimeFormat(dateLocale(language), { dateStyle: 'medium', timeZone }).format(
      new Date(value),
    );

  /** "Stop sharing": off every block; its items are private to its owner again. */
  const runStopSharing = async () => {
    setProblem(null);
    try {
      const { dashboards } = await stopSharing.mutateAsync(integration.id);
      toast.success(t('connect.card.stopSharingDone', { count: dashboards }));
    } catch (failure) {
      setProblem(errorMessage(t, failure, 'connect.card.stopSharingError'));
    }
  };

  /** Read-only or Read & write. Only turning writes on is confirmed first. */
  const setMode = async (mode: IntegrationMode) => {
    setProblem(null);
    try {
      const saved = await update.mutateAsync({ id: integration.id, body: { mode } });
      // A grant made while read-only lacks the write scope: offer the sign-in that adds it now.
      if (mode === 'read_write' && shouldOfferReconnect(saved, capabilities)) {
        setReconnectOffer(true);
      }
    } catch (failure) {
      setProblem(errorMessage(t, failure, 'connect.card.modeError'));
    }
  };

  const runTest = async () => {
    setProblem(null);
    try {
      setTest(await testConnection.mutateAsync(integration.id));
    } catch (failure) {
      setProblem(errorMessage(t, failure, 'connect.card.testError'));
    }
  };
  const runSync = async () => {
    setProblem(null);
    try {
      await syncNow.mutateAsync(integration.id);
    } catch (failure) {
      setProblem(errorMessage(t, failure, 'connect.card.syncError'));
    }
  };
  const confirmDisconnect = async () => {
    setDisconnectProgress(null);
    const withRemoval =
      removeAdded && provider === 'google_calendar' && integration.mode === 'read_write';
    // Out of time, still connected: the clean-up goes on by itself while it makes progress.
    const result = await disconnectCleanup.run(() =>
      disconnect.mutateAsync(
        withRemoval ? { id: integration.id, removeAdded: true } : integration.id,
      ),
    );
    if (result.kind === 'incomplete') {
      // Stopped (Cancel, or no progress): the dialog stays open and can continue.
      setDisconnectProgress(result.progress);
      return;
    }
    setConfirming(false);
    if (result.kind === 'done') {
      const all = finishProgress(result.totals, result.value);
      if (withRemoval) {
        toast.success(
          t('connect.pushed.removedSummary', {
            events: t('connect.pushed.removedEvents', { count: all.events }),
            calendars: t('connect.pushed.removedCalendars', { count: all.calendars }),
          }),
        );
      }
      if (all.failed > 0) {
        toast.warning(t('connect.pushed.failed', { count: all.failed }));
      }
      if (all.skipped > 0) {
        toast.info(t('connect.pushed.skipped', { count: all.skipped }));
      }
      return;
    }
    setProblem(errorMessage(t, result.failure, 'connect.card.disconnectError'));
  };

  /** "Remove": the events pushed with a connection that is no longer the workspace calendar. */
  const removeLeftover = async () => {
    setProblem(null);
    await leftover.run(integration.id);
  };

  const days = daysUntil(integration.expiresAt, now);
  const renew = needsRenewalHint(integration.expiresAt, now) && days !== null;
  const status = integration.status;
  // The server counts only events that are not on the current workspace calendar. Not shown
  // until the workspace calendar has loaded, so the count is never read against an unknown one.
  const pushedLeft =
    provider === 'google_calendar' && primary.isSuccess ? (integration.pushedEvents ?? 0) : 0;

  return (
    <article
      ref={card}
      id={anchor}
      tabIndex={-1}
      data-integration-account={provider}
      data-integration-id={integration.id}
      data-status={status}
      aria-label={integration.accountLabel}
      data-named={named ? '' : undefined}
      className={cn(
        'flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4 outline-none focus-visible:ring-2 focus-visible:ring-ring',
        named && 'ring-2 ring-ring',
      )}
    >
      <header className="flex items-start gap-3">
        <div className="flex min-w-0 flex-1 flex-col">
          <h3
            className="truncate text-sm leading-snug font-semibold"
            title={integration.accountLabel}
            data-account-label
            dir="auto"
          >
            {integration.accountLabel}
          </h3>
        </div>
        <p
          data-status-text
          className={
            status === 'connected'
              ? 'flex shrink-0 items-center gap-1.5 text-[13px]'
              : 'flex shrink-0 items-center gap-1.5 text-[13px] text-destructive'
          }
        >
          <span
            aria-hidden="true"
            className={
              status === 'connected'
                ? 'size-2 rounded-full bg-success'
                : 'size-2 rounded-full bg-destructive'
            }
          />
          {t(`connect.status.${status}`)}
        </p>
      </header>

      <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-1 text-[13px]">
        <dt className="text-muted-foreground">{t('connect.card.expires')}</dt>
        <dd data-expires>
          {integration.expiresAt === null
            ? t('connect.card.noExpiry')
            : dateOnly(integration.expiresAt)}
        </dd>
        <dt className="text-muted-foreground">{t('connect.card.lastSync')}</dt>
        <dd data-last-sync>
          {integration.lastSyncAt === null
            ? t('connect.card.neverSynced')
            : format(integration.lastSyncAt)}
        </dd>
      </dl>
      {renew ? (
        <p data-renewal-hint className="text-[13px] text-destructive">
          {days <= 0 ? t('connect.card.renewNow') : t('connect.card.renewSoon', { count: days })}
        </p>
      ) : null}
      <div
        data-sharing={shared ? 'shared' : 'private'}
        className="flex flex-wrap items-center gap-x-3 gap-y-1 text-[13px] text-muted-foreground"
      >
        <span className="min-w-0 flex-1 basis-48">
          {t(shared ? 'connect.card.shared' : 'connect.card.private')}
        </span>
        {shared ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-md:h-11"
            data-stop-sharing
            disabled={stopSharing.isPending}
            onClick={() => {
              setConfirmingStop(true);
            }}
          >
            {t('connect.card.stopSharing')}
          </Button>
        ) : null}
      </div>
      <div data-mode={integration.mode} className="flex items-start gap-3 text-[13px]">
        <div className="flex min-w-0 flex-1 flex-col">
          <label htmlFor={`mode-${integration.id}`} className="font-medium">
            {t('connect.card.mode')}:{' '}
            {t(
              integration.mode === 'read' ? 'connect.card.modeRead' : 'connect.card.modeReadWrite',
            )}
          </label>
          <span className="text-muted-foreground">
            {t(
              !integration.canSwitchMode
                ? 'connect.card.modeHintDemo'
                : integration.mode === 'read'
                  ? 'connect.card.modeHintRead'
                  : 'connect.card.modeHintReadWrite',
              { name },
            )}
          </span>
        </div>
        {/* Demo data stays read-only: no switch is offered for it. */}
        {!integration.canSwitchMode ? null : (
          <Switch
            id={`mode-${integration.id}`}
            data-mode-switch
            checked={integration.mode === 'read_write'}
            disabled={update.isPending}
            onCheckedChange={(checked) => {
              if (checked) {
                setConfirmingWrite(true);
              } else {
                void setMode('read');
              }
            }}
          />
        )}
      </div>
      <FileUnder workspaceId={workspaceId} integration={integration} />
      {pushedLeft <= 0 ? null : (
        <div data-pushed-leftover className="flex flex-col gap-1.5 text-[13px]">
          <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
            <span className="min-w-0 flex-1 basis-48">
              {t('connect.pushed.leftover', { count: pushedLeft })}
            </span>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="max-md:h-11"
              data-pushed-remove
              disabled={integration.mode === 'read' || leftover.pending}
              onClick={() => {
                setConfirmingRemove(true);
              }}
            >
              {t('connect.pushed.remove')}
            </Button>
          </div>
          {integration.mode === 'read' ? (
            <span className="text-muted-foreground">{t('connect.pushed.needsWrite')}</span>
          ) : null}
        </div>
      )}
      {provider !== 'google_calendar' ? null : (
        <CleanupNote
          outcome={leftover.outcome}
          pending={leftover.pending}
          runner={leftover.runner}
          onContinue={() => {
            void removeLeftover();
          }}
        />
      )}
      {run === undefined ? null : <SyncStatus run={run} />}
      {test === null ? null : (
        <p role="status" data-test-result={test.ok ? 'ok' : test.code} className="text-[13px]">
          {test.ok
            ? t('connect.card.testOk', { label: test.accountLabel })
            : t(`connect.testCodes.${test.code}`)}
        </p>
      )}
      {problem === null ? null : (
        <p role="alert" className="text-[13px] text-destructive">
          {problem}
        </p>
      )}

      {integration.needsReconnect ? (
        <div
          data-reconnect-finish
          className="flex flex-wrap items-center gap-x-3 gap-y-2 rounded-sm bg-sunken px-3 py-2.5 text-[13px]"
        >
          <span className="min-w-0 flex-1 basis-48">{t('connect.reconnect.notice', { name })}</span>
          <Button
            type="button"
            size="sm"
            className="max-md:h-11"
            data-reconnect-finish-button
            onClick={() => {
              onReconnect?.(integration);
            }}
          >
            {t('connect.oauth.reconnect')}
          </Button>
        </div>
      ) : null}

      <footer className="mt-auto flex flex-wrap items-center gap-2">
        <>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-md:h-11"
            disabled={testConnection.isPending}
            onClick={() => void runTest()}
          >
            {t('connect.card.test')}
          </Button>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="max-md:h-11"
            disabled={syncNow.isPending}
            onClick={() => void runSync()}
          >
            {t('connect.card.sync')}
          </Button>
          {integration.authMethod === 'oauth' ? (
            <>
              {onCalendars === undefined ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="max-md:h-11"
                  onClick={() => {
                    onCalendars(integration);
                  }}
                >
                  {t('connect.oauth.calendars')}
                </Button>
              )}
              {!hasResourcePicker(capabilities) ? null : (
                <Button
                  type="button"
                  variant="outline"
                  size="sm"
                  className="max-md:h-11"
                  data-oauth-resources={provider}
                  onClick={() => {
                    signIn.onResources(integration);
                  }}
                >
                  {t(`connect.resources.${provider}.button`)}
                </Button>
              )}
              {signIn.installUrl === null ? null : (
                <a
                  href={signIn.installUrl}
                  target="_blank"
                  rel="noopener noreferrer"
                  data-github-install
                  className="inline-flex min-h-6 items-center gap-1 text-[13px] underline underline-offset-2 max-md:min-h-11"
                >
                  {t('connect.signin.githubInstall')}
                  <ExternalLink aria-hidden="true" className="size-3.5" />
                </a>
              )}
              {onReconnect === undefined || integration.needsReconnect ? null : (
                <Button
                  type="button"
                  variant="ghost"
                  size="sm"
                  className="max-md:h-11"
                  onClick={() => {
                    onReconnect(integration);
                  }}
                >
                  {t('connect.oauth.reconnect')}
                </Button>
              )}
            </>
          ) : provider === 'google_calendar' ? null : (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="max-md:h-11"
              onClick={() => {
                onReplace(integration);
              }}
            >
              {t('connect.card.replace')}
            </Button>
          )}
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="text-destructive max-md:h-11"
            onClick={() => {
              setConfirming(true);
            }}
          >
            {t('connect.card.disconnect')}
          </Button>
        </>
      </footer>

      <AlertDialog open={confirmingRemove} onOpenChange={setConfirmingRemove}>
        <AlertDialogContent data-pushed-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('connect.pushed.confirmTitle', { count: integration.pushedEvents ?? 0 })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('connect.pushed.confirmBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connect.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void removeLeftover();
              }}
            >
              {t('connect.pushed.confirmDelete')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmingWrite} onOpenChange={setConfirmingWrite}>
        <AlertDialogContent data-mode-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connect.card.modeConfirmTitle', { name })}</AlertDialogTitle>
            <AlertDialogDescription>
              {t('connect.card.modeConfirmBody', { name })}
              {provider === 'google_calendar' ? ` ${t('connect.card.modeConfirmGcal')}` : ''}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connect.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void setMode('read_write');
              }}
            >
              {t('connect.card.modeConfirmAction')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={reconnectOffer} onOpenChange={setReconnectOffer}>
        <AlertDialogContent
          data-reconnect-confirm
          onCloseAutoFocus={(event) => {
            // "Later" leaves the card as it was: back on the switch that was just turned on.
            const target = card.current?.querySelector<HTMLElement>('[data-mode-switch]');
            if (target !== null && target !== undefined) {
              event.preventDefault();
              target.focus();
            }
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connect.reconnect.title', { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t('connect.reconnect.body', { name })}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connect.reconnect.later')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                // It was just switched: the list may still say read-only, the sign-in must not.
                onReconnect?.({ ...integration, mode: 'read_write' });
              }}
            >
              {t('connect.reconnect.now')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog open={confirmingStop} onOpenChange={setConfirmingStop}>
        <AlertDialogContent data-stop-sharing-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('connect.card.stopSharingTitle', {
                name: integration.accountLabel,
              })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('connect.card.stopSharingBody')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connect.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                void runStopSharing();
              }}
            >
              {t('connect.card.stopSharing')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>

      <AlertDialog
        open={confirming}
        onOpenChange={(open) => {
          setConfirming(open);
          setRemoveAdded(false);
          setDisconnectProgress(null);
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connect.card.disconnectTitle', { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t('connect.card.disconnectBody')}</AlertDialogDescription>
            {integration.authMethod === 'oauth' &&
            isOAuthSignIn(provider) &&
            capabilities !== undefined ? (
              <p className="text-sm text-muted-foreground" data-revoke-note>
                {revokesOnDisconnect(capabilities) ? (
                  t('connect.signin.revoked', { name })
                ) : (
                  <>
                    {t('connect.signin.revokeYourself', { name })}{' '}
                    {revokePageOf(capabilities) === null ? null : (
                      <a
                        href={revokePageOf(capabilities) ?? undefined}
                        target="_blank"
                        rel="noopener noreferrer"
                        className="underline underline-offset-2"
                      >
                        {t('connect.signin.revokePage', { name })}
                      </a>
                    )}
                  </>
                )}
              </p>
            ) : null}
            {provider === 'google_calendar' ? (
              <div className="flex flex-col gap-1">
                <div className="flex min-h-6 items-center gap-2 max-md:min-h-11">
                  <Checkbox
                    id={`remove-added-${integration.id}`}
                    data-remove-added
                    checked={removeAdded && integration.mode === 'read_write'}
                    disabled={integration.mode === 'read'}
                    onCheckedChange={(value) => {
                      setRemoveAdded(value === true);
                      setDisconnectProgress(null);
                    }}
                  />
                  <label htmlFor={`remove-added-${integration.id}`} className="text-sm">
                    {t('connect.card.removeAdded')}
                  </label>
                </div>
                <p className="ps-6 text-[13px] text-muted-foreground">
                  {t(
                    integration.mode === 'read'
                      ? 'connect.card.removeAddedNeedsWrite'
                      : 'connect.card.removeAddedHint',
                  )}
                </p>
                {removeAdded && disconnectCleanup.runner.running ? (
                  <div className="ps-6">
                    <CleanupRunning runner={disconnectCleanup.runner} />
                  </div>
                ) : disconnectProgress !== null && removeAdded ? (
                  <div className="ps-6">
                    <CleanupProgressLine
                      progress={disconnectProgress}
                      pending={disconnect.isPending}
                      onContinue={() => {
                        void confirmDisconnect();
                      }}
                    />
                  </div>
                ) : null}
              </div>
            ) : null}
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connect.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              disabled={disconnect.isPending || disconnectCleanup.runner.running}
              onClick={(event) => {
                // Stays open while it runs, and when the clean-up stops early.
                event.preventDefault();
                void confirmDisconnect();
              }}
            >
              {t('connect.card.disconnect')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </article>
  );
}
