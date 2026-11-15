import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import {
  useDisconnectIntegration,
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
import { Switch } from '@/components/ui/switch';
import { ProviderIcon } from '@/features/landing/ProviderIcon';
import { useLanguage } from '@/hooks/useLanguage';
import type { IntegrationStatusView } from '@api-types/api-contracts';
import type { IntegrationMode } from '@api-types/domain';
import type {
  ConnectableProvider,
  IntegrationTestResult,
  ProviderCapabilities,
  SyncRunView,
} from '@api-types/integrations';
import {
  comingSoonOf,
  hasResourcePicker,
  hasTokenFallback,
  revokePageOf,
  revokesOnDisconnect,
  isOAuthSignIn,
  type OAuthMode,
} from './oauthSetup';
import { PROVIDER_REGISTRY } from './providers';
import { daysUntil, needsRenewalHint } from './status';
import { SyncStatus } from './SyncStatus';
import { TokenFallback } from './TokenFallback';

interface IntegrationCardProps {
  workspaceId: string;
  provider: ConnectableProvider;
  /** Undefined: not connected. */
  integration?: IntegrationStatusView | undefined;
  /** It is on some block, so the whole workspace sees its items (GET …/integrations/sharing). */
  shared: boolean;
  run?: SyncRunView | undefined;
  /** Editors and owners connect; a connected card is always the member's own to manage. */
  canConnect: boolean;
  timeZone: string;
  now: Date;
  /** "Connect with <provider>": the OAuth sign-in, for every provider that is open. */
  onConnect: () => void;
  /** GitHub, Jira, ClickUp, Linear: opens the token form ("Use an API token instead"). */
  onTokenConnect?: (() => void) | undefined;
  onReplace: (integration: IntegrationStatusView) => void;
  /** A Google Calendar connected with Google: its calendar picker. */
  onCalendars?: ((integration: IntegrationStatusView) => void) | undefined;
  /** A connection made with OAuth: sign in again (same account). */
  onReconnect?: ((integration: IntegrationStatusView) => void) | undefined;
  /** What the server says this provider can do; undefined until the providers answer arrives. */
  capabilities?: ProviderCapabilities | undefined;
  /** What this stage can do about signing in, and the actions it leads to. */
  signIn: {
    mode: OAuthMode;
    /** Jira sites or ClickUp workspaces of a connected grant. */
    onResources: (integration: IntegrationStatusView) => void;
    /** GitHub: where the user installs the app on more repositories or organizations. */
    installUrl: string | null;
  };
}

/**
 * One connection: exactly the status shape (provider, account label, status, `expiresAt` with a
 * renewal hint 14 days ahead, `lastSyncAt`) and the sync run's counts. Never a token, a masked
 * hint or the last four characters.
 */
export function IntegrationCard({
  workspaceId,
  provider,
  integration,
  shared,
  run,
  canConnect,
  timeZone,
  now,
  onConnect,
  onTokenConnect,
  onReplace,
  onCalendars,
  onReconnect,
  capabilities,
  signIn,
}: IntegrationCardProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const spec = PROVIDER_REGISTRY[provider];
  const [test, setTest] = useState<IntegrationTestResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const [confirmingWrite, setConfirmingWrite] = useState(false);
  const testConnection = useTestIntegration(workspaceId);
  const syncNow = useSyncIntegration(workspaceId);
  const disconnect = useDisconnectIntegration(workspaceId);
  const stopSharing = useStopSharing(workspaceId);
  const update = useUpdateIntegration(workspaceId);
  const name = t(`sources.${provider}`);
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
    if (integration === undefined) {
      return;
    }
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
    if (integration === undefined) {
      return;
    }
    setProblem(null);
    try {
      await update.mutateAsync({ id: integration.id, body: { mode } });
    } catch (failure) {
      setProblem(errorMessage(t, failure, 'connect.card.modeError'));
    }
  };

  const runTest = async () => {
    if (integration === undefined) {
      return;
    }
    setProblem(null);
    try {
      setTest(await testConnection.mutateAsync(integration.id));
    } catch (failure) {
      setProblem(errorMessage(t, failure, 'connect.card.testError'));
    }
  };
  const runSync = async () => {
    if (integration === undefined) {
      return;
    }
    setProblem(null);
    try {
      await syncNow.mutateAsync(integration.id);
    } catch (failure) {
      setProblem(errorMessage(t, failure, 'connect.card.syncError'));
    }
  };
  const confirmDisconnect = async () => {
    if (integration === undefined) {
      return;
    }
    try {
      await disconnect.mutateAsync(integration.id);
    } catch (failure) {
      setProblem(errorMessage(t, failure, 'connect.card.disconnectError'));
    }
  };

  const days = integration === undefined ? null : daysUntil(integration.expiresAt, now);
  const renew =
    integration !== undefined && needsRenewalHint(integration.expiresAt, now) && days !== null;
  const status = integration?.status;
  const comingSoon = comingSoonOf(capabilities);

  return (
    <article
      data-integration-card={provider}
      data-status={status ?? 'none'}
      data-coming-soon={comingSoon ? 'true' : undefined}
      aria-label={name}
      className="flex min-w-0 flex-col gap-4 rounded-lg border bg-card p-4"
    >
      <header className="flex items-start gap-3">
        <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-sunken">
          <ProviderIcon name={spec.icon} className="size-5" />
        </span>
        <div className="flex min-w-0 flex-1 flex-col">
          <h2 className="text-sm leading-snug font-semibold">{name}</h2>
          {integration === undefined ? null : (
            <p
              className="truncate text-[13px] text-muted-foreground"
              title={integration.accountLabel}
              data-account-label
              dir="auto"
            >
              {integration.accountLabel}
            </p>
          )}
        </div>
        {comingSoon ? (
          <p
            data-coming-soon-badge
            className="shrink-0 rounded-full border px-2 py-0.5 text-[12px] font-medium text-muted-foreground"
          >
            {t('connect.signin.comingSoon')}
          </p>
        ) : (
          <p
            data-status-text
            className={
              status === 'connected'
                ? 'flex shrink-0 items-center gap-1.5 text-[13px]'
                : status === undefined
                  ? 'shrink-0 text-[13px] text-muted-foreground'
                  : 'flex shrink-0 items-center gap-1.5 text-[13px] text-destructive'
            }
          >
            {status === undefined ? null : (
              <span
                aria-hidden="true"
                className={
                  status === 'connected'
                    ? 'size-2 rounded-full bg-success'
                    : 'size-2 rounded-full bg-destructive'
                }
              />
            )}
            {t(status === undefined ? 'connect.status.none' : `connect.status.${status}`)}
          </p>
        )}
      </header>

      {integration === undefined ? (
        <p className="text-[13px] text-muted-foreground">{t(`connect.about.${provider}`)}</p>
      ) : (
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
      )}
      {renew ? (
        <p data-renewal-hint className="text-[13px] text-destructive">
          {days <= 0 ? t('connect.card.renewNow') : t('connect.card.renewSoon', { count: days })}
        </p>
      ) : null}
      {integration === undefined ? null : (
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
      )}
      {integration === undefined ? null : (
        <div data-mode={integration.mode} className="flex items-start gap-3 text-[13px]">
          <div className="flex min-w-0 flex-1 flex-col">
            <label htmlFor={`mode-${integration.id}`} className="font-medium">
              {t('connect.card.mode')}:{' '}
              {t(
                integration.mode === 'read'
                  ? 'connect.card.modeRead'
                  : 'connect.card.modeReadWrite',
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

      <footer className="mt-auto flex flex-wrap items-center gap-2">
        {integration === undefined ? (
          canConnect && !comingSoon ? (
            <>
              <Button
                type="button"
                size="sm"
                className="max-md:h-11"
                data-oauth-connect={provider}
                data-oauth-mode={signIn.mode}
                disabled={signIn.mode !== 'connect'}
                onClick={onConnect}
              >
                {signIn.mode === 'unavailable'
                  ? t('connect.signin.comingSoon')
                  : t('connect.signin.connect', { name })}
              </Button>
              {signIn.mode === 'connect' ? (
                <p className="basis-full text-[13px] text-muted-foreground" data-oauth-consent>
                  {t(`connect.signin.consent.${provider}`)}
                </p>
              ) : null}
              {hasTokenFallback(provider) && onTokenConnect !== undefined ? (
                <TokenFallback provider={provider} name={name} onOpen={onTokenConnect} />
              ) : null}
            </>
          ) : null
        ) : (
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
                {onReconnect === undefined ? null : (
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
        )}
      </footer>

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

      <AlertDialog open={confirmingStop} onOpenChange={setConfirmingStop}>
        <AlertDialogContent data-stop-sharing-confirm>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('connect.card.stopSharingTitle', {
                name: integration?.accountLabel ?? name,
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

      <AlertDialog open={confirming} onOpenChange={setConfirming}>
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>{t('connect.card.disconnectTitle', { name })}</AlertDialogTitle>
            <AlertDialogDescription>{t('connect.card.disconnectBody')}</AlertDialogDescription>
            {integration?.authMethod === 'oauth' &&
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
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connect.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
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
