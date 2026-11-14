import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { ExternalLink } from 'lucide-react';
import { toast } from 'sonner';
import { errorMessage } from '@/api/errors';
import {
  useDisconnectIntegration,
  useStopSharing,
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
import { ProviderIcon } from '@/features/landing/ProviderIcon';
import { useLanguage } from '@/hooks/useLanguage';
import type { IntegrationStatusView } from '@api-types/api-contracts';
import type {
  ConnectableProvider,
  IntegrationTestResult,
  SyncRunView,
} from '@api-types/integrations';
import {
  hasResourcePicker,
  REVOKE_PAGES,
  revokesOnDisconnect,
  isOAuthSignIn,
  type OAuthMode,
} from './oauthSetup';
import { PROVIDER_REGISTRY } from './providers';
import { daysUntil, needsRenewalHint } from './status';
import { SyncStatus } from './SyncStatus';

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
  /** Google Calendar: connects with Google (OAuth); the other providers open their form. */
  onConnect: () => void;
  /** GitHub, Jira, ClickUp, Linear: opens the token form ("Use a token instead"). */
  onTokenConnect?: (() => void) | undefined;
  onReplace: (integration: IntegrationStatusView) => void;
  /** A Google Calendar connected with Google: its calendar picker. */
  onCalendars?: ((integration: IntegrationStatusView) => void) | undefined;
  /** A connection made with OAuth: sign in again (same account). */
  onReconnect?: ((integration: IntegrationStatusView) => void) | undefined;
  /**
   * GitHub, Jira, ClickUp and Linear: what the server can do about signing in (the owner's view),
   * and the actions it leads to. Absent for the other providers.
   */
  signIn?:
    | {
        mode: OAuthMode;
        onSetup: () => void;
        /** Jira sites or ClickUp workspaces of a connected grant. */
        onResources: (integration: IntegrationStatusView) => void;
        /** GitHub: where the user installs the app on more repositories or organizations. */
        installUrl: string | null;
      }
    | undefined;
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
  signIn,
}: IntegrationCardProps) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const spec = PROVIDER_REGISTRY[provider];
  const [test, setTest] = useState<IntegrationTestResult | null>(null);
  const [problem, setProblem] = useState<string | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [confirmingStop, setConfirmingStop] = useState(false);
  const testConnection = useTestIntegration(workspaceId);
  const syncNow = useSyncIntegration(workspaceId);
  const disconnect = useDisconnectIntegration(workspaceId);
  const stopSharing = useStopSharing(workspaceId);
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

  return (
    <article
      data-integration-card={provider}
      data-status={status ?? 'none'}
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
          canConnect ? (
            signIn !== undefined && signIn.mode !== 'token' ? (
              <>
                {signIn.mode === 'connect' ? (
                  <Button
                    type="button"
                    size="sm"
                    className="max-md:h-11"
                    data-oauth-connect={provider}
                    onClick={onConnect}
                  >
                    {t('connect.signin.connect', { name })}
                  </Button>
                ) : signIn.mode === 'setup' ? (
                  <Button
                    type="button"
                    size="sm"
                    className="max-md:h-11"
                    data-oauth-setup={provider}
                    onClick={signIn.onSetup}
                  >
                    {t('connect.signin.setup', { name })}
                  </Button>
                ) : null}
                <Button
                  type="button"
                  variant={signIn.mode === 'unavailable' ? 'outline' : 'ghost'}
                  size="sm"
                  className="max-md:h-11"
                  data-use-token={provider}
                  onClick={onTokenConnect}
                >
                  {t('connect.signin.useToken')}
                </Button>
                {signIn.mode === 'connect' ? (
                  <p className="basis-full text-[13px] text-muted-foreground" data-oauth-consent>
                    {t(`connect.signin.consent.${provider}`)}
                  </p>
                ) : signIn.mode === 'unavailable' ? (
                  <p
                    className="basis-full text-[13px] text-muted-foreground"
                    data-oauth-unavailable
                  >
                    {t('connect.signin.unavailable', { name })}
                  </p>
                ) : null}
              </>
            ) : (
              <>
                <Button type="button" size="sm" className="max-md:h-11" onClick={onConnect}>
                  {t(
                    provider === 'google_calendar'
                      ? 'connect.oauth.connect'
                      : 'connect.card.connect',
                  )}
                </Button>
              </>
            )
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
                {signIn === undefined || !hasResourcePicker(provider) ? null : (
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
                {signIn?.installUrl === undefined || signIn.installUrl === null ? null : (
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
            ) : (
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
        <a
          href={spec.docsUrl}
          target="_blank"
          rel="noopener noreferrer"
          className="ms-auto inline-flex min-h-6 items-center gap-1 text-[13px] text-muted-foreground underline underline-offset-2 hover:text-foreground max-md:min-h-11"
        >
          {t('connect.card.docs')}
          <ExternalLink aria-hidden="true" className="size-3.5" />
        </a>
      </footer>

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
            {integration?.authMethod === 'oauth' && isOAuthSignIn(provider) ? (
              <p className="text-sm text-muted-foreground" data-revoke-note>
                {revokesOnDisconnect(provider) ? (
                  t('connect.signin.revoked', { name })
                ) : (
                  <>
                    {t('connect.signin.revokeYourself', { name })}{' '}
                    <a
                      href={REVOKE_PAGES[provider]}
                      target="_blank"
                      rel="noopener noreferrer"
                      className="underline underline-offset-2"
                    >
                      {t('connect.signin.revokePage', { name })}
                    </a>
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
