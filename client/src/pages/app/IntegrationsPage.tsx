import { useCallback, useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';
import { useTranslation } from 'react-i18next';
import { CircleAlert, Info } from 'lucide-react';
import { toast } from 'sonner';
import { apiErrorStatus, errorMessage } from '@/api/errors';
import {
  useIntegrations,
  useIntegrationSharing,
  useIntegrationSyncRuns,
  useOAuthProviders,
  useRefreshIntegrations,
} from '@/api/queries/integrations';
import {
  consumeConnectLink,
  startGoogleCalendarOAuth,
  startProviderOAuth,
} from '@/api/services/integrationService';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';
import { pageTitle } from '@/data/pageTitles';
import { ConnectDialog } from '@/features/integrations/ConnectDialog';
import { GcalCalendarPicker } from '@/features/integrations/GcalCalendarPicker';
import { GcalSyncButton } from '@/features/integrations/GcalSyncButton';
import { IntegrationCard } from '@/features/integrations/IntegrationCard';
import {
  OAUTH_RETURN_PARAMS,
  oauthFailure,
  oauthReturnOf,
} from '@/features/integrations/oauthReturn';
import { TokenFallback } from '@/features/integrations/TokenFallback';
import { OAuthResourcePicker } from '@/features/integrations/OAuthResourcePicker';
import {
  hasOAuthSignIn,
  capabilitiesOf,
  comingSoonOf,
  hasResourcePicker,
  hasTokenFallback,
  isOAuthSignIn,
  oauthMode,
} from '@/features/integrations/oauthSetup';
import { PROVIDER_ORDER } from '@/features/integrations/providers';
import { latestRun } from '@/features/integrations/status';
import { EmptyIcon, EmptyState } from '@/features/shell/EmptyState';
import { PageContainer, PageHeader } from '@/features/shell/PageHeader';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { useNow } from '@/hooks/useNow';
import type { IntegrationStatusView, WorkspaceView } from '@api-types/api-contracts';
import type { ConnectableProvider } from '@api-types/integrations';
import { CONNECTABLE_PROVIDERS } from '@api-types/integrations';

type Dialog =
  | { kind: 'connect'; provider: ConnectableProvider; existingId?: string }
  | { kind: 'calendars'; integration: IntegrationStatusView }
  | { kind: 'resources'; integration: IntegrationStatusView };

interface CardEntry {
  provider: ConnectableProvider;
  integration: IntegrationStatusView | undefined;
  /** The "connect another account" tile after a provider's connected accounts. */
  another?: true;
}

function isConnectable(value: string | null): value is ConnectableProvider {
  return value !== null && (CONNECTABLE_PROVIDERS as readonly string[]).includes(value);
}

const LINK_PARAMS = ['workspace', 'connect', 'link'] as const;

/**
 * `?workspace&connect&link` from an agent's connect link: consumed once (single use), then that
 * provider's form opens. A used or expired link says so; the params leave the URL either way.
 */
function useConnectLink(
  workspace: WorkspaceView,
  canConnect: boolean,
  open: (dialog: Dialog) => void,
  signIn: (provider: ConnectableProvider) => void,
): string | null {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const [message, setMessage] = useState<string | null>(null);
  const consumed = useRef<string | null>(null);
  const link = params.get('link');
  const connect = params.get('connect');
  const target = params.get('workspace');

  // A link this user can't use is explained without consuming it (it stays valid for an editor).
  const refusal =
    link === null
      ? null
      : !canConnect
        ? t('connect.link.notOwner')
        : target !== null && target !== workspace.id
          ? t('connect.link.otherWorkspace')
          : null;

  useEffect(() => {
    if (link === null || refusal !== null || consumed.current === link) {
      return;
    }
    consumed.current = link;
    const clear = () => {
      setParams(
        (current) => {
          const next = new URLSearchParams(current);
          LINK_PARAMS.forEach((key) => {
            next.delete(key);
          });
          return next;
        },
        { replace: true },
      );
    };
    consumeConnectLink(workspace.id, link, { suppressErrorToast: true })
      .then(({ data }) => {
        setMessage(null);
        const provider = isConnectable(connect) ? connect : data.provider;
        // A provider with no token form (Google Calendar) goes straight to its sign-in.
        if (hasTokenFallback(provider)) {
          open({ kind: 'connect', provider });
        } else {
          signIn(provider);
        }
      })
      .catch((failure: unknown) => {
        const status = apiErrorStatus(failure);
        setMessage(
          status === 410
            ? t('connect.link.used')
            : status === 404
              ? t('connect.link.expired')
              : status === 403
                ? t('connect.link.notYours')
                : errorMessage(t, failure, 'connect.link.failed'),
        );
      })
      .finally(clear);
  }, [link, connect, refusal, workspace.id, open, signIn, setParams, t]);

  return refusal ?? message;
}

/**
 * Back from Google: `?connected=<id>` or `?oauth_error=<code>` becomes a toast, once, and leaves
 * the URL (it is never a token or a code: the server's callback sends only these).
 */
function useOAuthReturn(onConnected: () => void): void {
  const { t } = useTranslation();
  const [params, setParams] = useSearchParams();
  const shown = useRef(false);
  const connected = params.get('connected');
  const failed = params.get('oauth_error');

  useEffect(() => {
    const result = oauthReturnOf(
      new URLSearchParams({
        ...(connected === null ? {} : { connected }),
        ...(failed === null ? {} : { oauth_error: failed }),
      }),
    );
    if (result === null || shown.current) {
      return;
    }
    shown.current = true;
    if (result.kind === 'connected') {
      toast.success(t('connect.oauth.connected'));
      onConnected();
    } else {
      toast.error(errorMessage(t, oauthFailure(result.code), 'connect.oauth.startFailed'));
    }
    setParams(
      (current) => {
        const next = new URLSearchParams(current);
        OAUTH_RETURN_PARAMS.forEach((key) => {
          next.delete(key);
        });
        return next;
      },
      { replace: true },
    );
  }, [connected, failed, onConnected, setParams, t]);
}

/**
 * PERMISSIONS-V2: every card is the member's own connection (other members' never reach this
 * page; they show as provider icons on Members). Editors and owners connect; viewers manage what
 * they already have.
 */
function Cards({ workspace, canConnect }: { workspace: WorkspaceView; canConnect: boolean }) {
  const { t } = useTranslation();
  const now = useNow();
  const integrations = useIntegrations(workspace.id);
  const sharing = useIntegrationSharing(workspace.id);
  const runs = useIntegrationSyncRuns(workspace.id);
  const [dialog, setDialog] = useState<Dialog | null>(null);
  const refresh = useRefreshIntegrations(workspace.id);
  const { language } = useLanguage();
  const [starting, setStarting] = useState(false);
  const oauthProviders = useOAuthProviders(workspace.id, true);
  const infoOf = (provider: ConnectableProvider) =>
    oauthProviders.data?.providers.find((entry) => entry.provider === provider);
  const capsOf = (provider: ConnectableProvider) => capabilitiesOf(oauthProviders.data, provider);
  const modeOf = (provider: ConnectableProvider) =>
    hasOAuthSignIn(provider)
      ? oauthMode(infoOf(provider), oauthProviders.isPending)
      : ('unavailable' as const);
  /**
   * Sign in with the provider: the server's authorize URL, then the browser goes there. Google
   * Calendar and GitHub, Jira, ClickUp and Linear share this one path.
   */
  const startOAuth = async (provider: ConnectableProvider, integrationId?: string) => {
    setStarting(true);
    try {
      const body = { lng: language, ...(integrationId === undefined ? {} : { integrationId }) };
      const { data } = isOAuthSignIn(provider)
        ? await startProviderOAuth(workspace.id, provider, body, { suppressErrorToast: true })
        : await startGoogleCalendarOAuth(workspace.id, body, { suppressErrorToast: true });
      window.location.assign(data.authorizeUrl);
    } catch (failure) {
      setStarting(false);
      toast.error(errorMessage(t, failure, 'connect.oauth.startFailed'));
    }
  };

  const linkMessage = useConnectLink(workspace, canConnect, setDialog, (provider) => {
    void startOAuth(provider);
  });
  const onConnected = useCallback(() => {
    void refresh();
  }, [refresh]);
  useOAuthReturn(onConnected);

  if (integrations.data === undefined) {
    return integrations.isError ? (
      <EmptyState
        visual={
          <EmptyIcon>
            <CircleAlert aria-hidden="true" />
          </EmptyIcon>
        }
        title={t('connect.loadError')}
        body={t('connect.loadErrorBody')}
        action={
          <Button
            variant="outline"
            onClick={() => {
              void integrations.refetch();
            }}
          >
            {t('dashboard.retry')}
          </Button>
        }
      />
    ) : (
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3" aria-busy="true">
        {PROVIDER_ORDER.slice(0, 3).map((provider) => (
          <Skeleton key={provider} className="h-48 rounded-lg" />
        ))}
      </div>
    );
  }

  const byProvider = (provider: ConnectableProvider) =>
    integrations.data.filter((entry) => entry.provider === provider);
  const cards = PROVIDER_ORDER.flatMap<CardEntry>((provider) => {
    // Coming soon (Moodle): one card with a badge, whatever a demo workspace holds.
    const connected = comingSoonOf(capsOf(provider)) ? [] : byProvider(provider);
    if (connected.length === 0) {
      return [{ provider, integration: undefined }];
    }
    const entries: CardEntry[] = connected.map((integration) => ({ provider, integration }));
    // Many-to-one: every connection is its own integration, so each provider offers another.
    return canConnect ? [...entries, { provider, integration: undefined, another: true }] : entries;
  });
  const google = (provider: ConnectableProvider): boolean => provider === 'google_calendar';
  /** What "connect" does: sign in with the provider (OAuth is always the first way). */
  const connect = (provider: ConnectableProvider) => {
    if (modeOf(provider) === 'connect') {
      void startOAuth(provider);
    }
  };
  const anotherTitle = (provider: ConnectableProvider): string =>
    google(provider)
      ? t('connect.oauth.anotherTitle')
      : t('connect.another.title', { name: t(`sources.${provider}`) });
  const replace = (integration: IntegrationStatusView) => {
    setDialog({
      kind: 'connect',
      provider: integration.provider as ConnectableProvider,
      existingId: integration.id,
    });
  };

  return (
    <>
      {canConnect ? null : (
        <p
          data-integrations-read-only
          className="mb-6 flex items-start gap-2 rounded-sm bg-sunken px-3 py-2.5 text-sm text-muted-foreground"
        >
          <Info className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{t('connect.readOnly')}</span>
        </p>
      )}
      {linkMessage === null ? null : (
        <p
          role="alert"
          data-connect-link-error
          className="mb-6 flex items-start gap-2 rounded-sm border border-destructive/30 bg-destructive/5 px-3 py-2.5 text-sm text-destructive"
        >
          <CircleAlert className="mt-0.5 size-4 shrink-0" aria-hidden="true" />
          <span>{linkMessage}</span>
        </p>
      )}
      <div className="grid grid-cols-1 gap-4 md:grid-cols-2 xl:grid-cols-3">
        {cards.map(({ provider, integration, another }) =>
          another === true ? (
            <article
              key={`${provider}-another`}
              data-connect-another={provider}
              aria-label={anotherTitle(provider)}
              className="flex min-w-0 flex-wrap items-center justify-between gap-x-4 gap-y-2 self-start rounded-lg border border-dashed px-4 py-3"
            >
              <div className="flex min-w-0 flex-1 basis-48 flex-col">
                <h2 className="text-sm leading-snug font-semibold">{anotherTitle(provider)}</h2>
                <p className="text-[13px] text-muted-foreground">
                  {google(provider) ? t('connect.oauth.anotherBody') : t('connect.another.body')}
                </p>
              </div>
              <footer>
                <Button
                  type="button"
                  size="sm"
                  variant="outline"
                  className="max-md:h-11"
                  disabled={starting || modeOf(provider) !== 'connect'}
                  onClick={() => {
                    connect(provider);
                  }}
                >
                  {t(google(provider) ? 'connect.oauth.another' : 'connect.another.button')}
                </Button>
                {hasTokenFallback(provider) ? (
                  <TokenFallback
                    provider={provider}
                    name={t(`sources.${provider}`)}
                    onOpen={() => {
                      setDialog({ kind: 'connect', provider });
                    }}
                  />
                ) : null}
              </footer>
            </article>
          ) : (
            <IntegrationCard
              key={integration?.id ?? provider}
              workspaceId={workspace.id}
              provider={provider}
              capabilities={capsOf(provider)}
              integration={integration}
              shared={integration !== undefined && sharing.data?.has(integration.id) === true}
              run={integration === undefined ? undefined : latestRun(runs.data, integration.id)}
              canConnect={canConnect}
              timeZone={workspace.settings.timezone}
              now={now}
              onConnect={() => {
                connect(provider);
              }}
              onTokenConnect={() => {
                setDialog({ kind: 'connect', provider });
              }}
              signIn={{
                mode: modeOf(provider),
                onResources: (entry) => {
                  setDialog({ kind: 'resources', integration: entry });
                },
                installUrl: infoOf(provider)?.installUrl ?? null,
              }}
              onReplace={replace}
              onCalendars={
                google(provider)
                  ? (entry) => {
                      setDialog({ kind: 'calendars', integration: entry });
                    }
                  : undefined
              }
              onReconnect={(entry) => void startOAuth(provider, entry.id)}
            />
          ),
        )}
      </div>
      {dialog?.kind === 'calendars' ? (
        <GcalCalendarPicker
          key={dialog.integration.id}
          workspaceId={workspace.id}
          integration={dialog.integration}
          onClose={() => {
            setDialog(null);
          }}
        />
      ) : dialog?.kind === 'resources' ? (
        hasResourcePicker(capsOf(dialog.integration.provider as ConnectableProvider)) &&
        (dialog.integration.provider === 'jira' || dialog.integration.provider === 'clickup') ? (
          <OAuthResourcePicker
            key={dialog.integration.id}
            workspaceId={workspace.id}
            integration={dialog.integration}
            kind={dialog.integration.provider}
            onClose={() => {
              setDialog(null);
            }}
          />
        ) : null
      ) : dialog === null ? null : (
        <ConnectDialog
          key={`${dialog.provider}-${dialog.existingId ?? 'new'}`}
          workspaceId={workspace.id}
          provider={dialog.provider}
          existingId={dialog.existingId}
          onClose={() => {
            setDialog(null);
          }}
        />
      )}
    </>
  );
}

/**
 * Connections (FRONTEND.md §8, PERMISSIONS-V2): a card per source with the member's own
 * connections, each with exactly the status shape and whether it is shared. Editors and owners
 * connect; each member tests, syncs, replaces credentials, stops sharing and disconnects their
 * own. The server refuses the rest anyway.
 */
export default function IntegrationsPage() {
  const { t } = useTranslation();
  const { workspace, role } = useCurrentWorkspace();
  const canConnect = role === 'owner' || role === 'editor';
  return (
    <PageContainer>
      <PageMetadata title={pageTitle(t('app.integrations.title'))} noIndex />
      <PageHeader
        title={t('app.integrations.title')}
        description={t('connect.description')}
        actions={<GcalSyncButton />}
      />
      {workspace === null ? null : (
        <Cards key={workspace.id} workspace={workspace} canConnect={canConnect} />
      )}
    </PageContainer>
  );
}
