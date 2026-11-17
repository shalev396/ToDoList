import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { useLocation } from 'react-router-dom';
import { ScrollArea } from '@/components/ui/scroll-area';
import { Button } from '@/components/ui/button';
import { Sheet, SheetContent, SheetHeader, SheetTitle } from '@/components/ui/sheet';
import { ProviderIcon } from '@/features/landing/ProviderIcon';
import { cn } from '@/lib/utils';
import type { IntegrationStatusView } from '@api-types/api-contracts';
import type {
  ConnectableProvider,
  ProviderCapabilities,
  SyncRunView,
} from '@api-types/integrations';
import { integrationAnchor } from './anchor';
import { IntegrationCard } from './IntegrationCard';
import { comingSoonOf, hasTokenFallback, type OAuthMode } from './oauthSetup';
import { isSyncing, summarizeProvider, type ProviderHealth } from './providerSummary';
import { PROVIDER_REGISTRY } from './providers';
import { latestRun } from './status';
import { TokenFallback } from './TokenFallback';

interface ProviderCardProps {
  workspaceId: string;
  provider: ConnectableProvider;
  /** The member's own connections of this provider (none: not connected). */
  integrations: readonly IntegrationStatusView[];
  /** Ids of the connections that are on some block. */
  shared: ReadonlySet<string> | undefined;
  runs: readonly SyncRunView[] | undefined;
  /** Editors and owners connect; every connection shown is the member's own to manage. */
  canConnect: boolean;
  timeZone: string;
  now: Date;
  capabilities: ProviderCapabilities | undefined;
  /** What this stage can do about signing in. */
  signInMode: OAuthMode;
  /** "Connect with <provider>": the OAuth sign-in. */
  onConnect: () => void;
  /** Opens the token form ("Use an API token instead"). */
  onTokenConnect: () => void;
  onReplace: (integration: IntegrationStatusView) => void;
  onCalendars?: ((integration: IntegrationStatusView) => void) | undefined;
  onReconnect: (integration: IntegrationStatusView) => void;
  onResources: (integration: IntegrationStatusView) => void;
  installUrl: string | null;
  /** A sign-in is starting: its buttons wait. */
  starting: boolean;
}

const HEALTH_DOT: Record<ProviderHealth, string> = {
  error: 'bg-destructive',
  needs_reconnect: 'bg-destructive',
  syncing: 'bg-muted-foreground',
  ok: 'bg-success',
};

/**
 * One card per provider. Without an account it offers Connect; with one or more it says how many
 * and how they are doing, and its Manage button opens a side panel with every account of the
 * provider (each its own IntegrationCard) and "Connect another account".
 */
export function ProviderCard({
  workspaceId,
  provider,
  integrations,
  shared,
  runs,
  canConnect,
  timeZone,
  now,
  capabilities,
  signInMode,
  onConnect,
  onTokenConnect,
  onReplace,
  onCalendars,
  onReconnect,
  onResources,
  installUrl,
  starting,
}: ProviderCardProps) {
  const { t } = useTranslation();
  const { hash } = useLocation();
  const spec = PROVIDER_REGISTRY[provider];
  const name = t(`sources.${provider}`);
  const comingSoon = comingSoonOf(capabilities, provider);
  const accounts = comingSoon ? [] : integrations;
  const summary = summarizeProvider(accounts, (id) => isSyncing(latestRun(runs, id)));
  // The item sheet links to `#integration-<id>`: the panel of that connection opens, and its card
  // takes the focus (the panel's own opening focus yields to it).
  const named = accounts.some((entry) => hash === `#${integrationAnchor(entry.id)}`);
  const [opened, setOpened] = useState(named);
  const [wasNamed, setWasNamed] = useState(named);
  if (named !== wasNamed) {
    setWasNamed(named);
    if (named) {
      setOpened(true);
    }
  }
  // Its last account was disconnected: nothing is left to manage.
  const open = opened && accounts.length > 0;

  const connectLabel =
    signInMode === 'unavailable'
      ? t('connect.signin.comingSoon')
      : t('connect.signin.connect', { name });
  const connectDisabled = starting || signInMode !== 'connect';

  return (
    <article
      data-integration-card={provider}
      data-count={summary.count}
      data-health={summary.health ?? 'none'}
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
          {summary.count === 0 ? null : (
            <p
              className="truncate text-[13px] text-muted-foreground"
              title={summary.label ?? undefined}
              data-provider-summary
              dir="auto"
            >
              {summary.label ?? t('connect.provider.accounts', { count: summary.count })}
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
            className={cn(
              'flex shrink-0 items-center gap-1.5 text-[13px]',
              summary.health === undefined && 'text-muted-foreground',
              (summary.health === 'error' || summary.health === 'needs_reconnect') &&
                'text-destructive',
            )}
          >
            {summary.health === undefined ? null : (
              <span
                aria-hidden="true"
                className={cn('size-2 rounded-full', HEALTH_DOT[summary.health])}
              />
            )}
            {t(
              summary.health === undefined
                ? 'connect.status.none'
                : `connect.provider.health.${summary.health}`,
            )}
          </p>
        )}
      </header>

      {summary.count === 0 ? (
        <p className="text-[13px] text-muted-foreground">{t(`connect.about.${provider}`)}</p>
      ) : null}

      <footer className="mt-auto flex flex-wrap items-center gap-2">
        {summary.count > 0 ? (
          <Button
            type="button"
            size="sm"
            variant="outline"
            className="max-md:h-11"
            data-integration-manage={provider}
            onClick={() => {
              setOpened(true);
            }}
          >
            {t('connect.provider.manage')}
          </Button>
        ) : canConnect && !comingSoon ? (
          <>
            <Button
              type="button"
              size="sm"
              className="max-md:h-11"
              data-oauth-connect={provider}
              data-oauth-mode={signInMode}
              disabled={signInMode !== 'connect'}
              onClick={onConnect}
            >
              {connectLabel}
            </Button>
            {signInMode === 'connect' ? (
              <p className="basis-full text-[13px] text-muted-foreground" data-oauth-consent>
                {t(`connect.signin.consent.${provider}`)}
              </p>
            ) : null}
            {hasTokenFallback(provider) ? (
              <TokenFallback provider={provider} name={name} onOpen={onTokenConnect} />
            ) : null}
          </>
        ) : null}
      </footer>

      <Sheet open={open} onOpenChange={setOpened}>
        <SheetContent
          aria-describedby={undefined}
          closeLabel={t('connect.provider.close')}
          className="w-[min(32rem,100vw)] sm:max-w-lg"
          data-integration-panel={provider}
          onOpenAutoFocus={(event) => {
            if (named) {
              event.preventDefault();
            }
          }}
        >
          <SheetHeader className="pe-14">
            <div className="flex items-center gap-3">
              <span className="flex size-9 shrink-0 items-center justify-center rounded-md bg-sunken">
                <ProviderIcon name={spec.icon} className="size-5" />
              </span>
              <SheetTitle className="min-w-0 truncate">
                {t('connect.provider.panelTitle', { name })}
              </SheetTitle>
            </div>
          </SheetHeader>
          <ScrollArea focusable className="min-h-0 flex-1">
            <div className="flex flex-col gap-4 px-4 pb-4">
              {accounts.map((integration) => (
                <IntegrationCard
                  key={integration.id}
                  workspaceId={workspaceId}
                  provider={provider}
                  capabilities={capabilities}
                  integration={integration}
                  shared={shared?.has(integration.id) === true}
                  run={latestRun(runs, integration.id)}
                  timeZone={timeZone}
                  now={now}
                  signIn={{ onResources, installUrl }}
                  onReplace={onReplace}
                  onCalendars={onCalendars}
                  onReconnect={onReconnect}
                />
              ))}
              {canConnect ? (
                <section
                  data-connect-another={provider}
                  aria-label={t('connect.provider.another')}
                  className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 rounded-lg border border-dashed px-4 py-3"
                >
                  <div className="flex min-w-0 flex-1 basis-48 flex-col">
                    <h3 className="text-sm leading-snug font-semibold">
                      {t('connect.provider.another')}
                    </h3>
                    <p className="text-[13px] text-muted-foreground">
                      {t('connect.provider.anotherBody')}
                    </p>
                  </div>
                  <Button
                    type="button"
                    size="sm"
                    variant="outline"
                    className="max-md:h-11"
                    data-oauth-connect-another={provider}
                    disabled={connectDisabled}
                    onClick={onConnect}
                  >
                    {t('connect.provider.anotherButton')}
                  </Button>
                  {hasTokenFallback(provider) ? (
                    <TokenFallback provider={provider} name={name} onOpen={onTokenConnect} />
                  ) : null}
                </section>
              ) : null}
            </div>
          </ScrollArea>
        </SheetContent>
      </Sheet>
    </article>
  );
}
