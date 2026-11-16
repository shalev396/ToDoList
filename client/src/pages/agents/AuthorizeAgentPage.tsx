import { useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { useQuery } from '@tanstack/react-query';
import { useTranslation } from 'react-i18next';
import { Bot, CircleAlert } from 'lucide-react';
import { apiErrorCode, apiErrorStatus, errorMessage } from '@/api/errors';
import { approveConsent, denyConsent, getConsent } from '@/api/services/mcpOAuthService';
import { FormError } from '@/components/auth/auth-ui';
import { PageMetadata } from '@/components/shared/PageMetadata';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select';
import { Skeleton } from '@/components/ui/skeleton';
import { pageTitle } from '@/data/pageTitles';
import { initialChoice, scopesFor, type ConsentChoice } from '@/features/agents/consent';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { pathTo, ROUTES } from '@/router/routes';
import type { ConsentView } from '@api-types/api-contracts';
import type { AgentScope } from '@api-types/domain';

/** i18n keys can't hold the scope's colon. */
const scopeKey = (scope: AgentScope) => scope.replace(':', '_');

const NAME_MAX = 80;

function Frame({ children }: { children: React.ReactNode }) {
  const { t } = useTranslation();
  return (
    <div className="mx-auto flex w-full max-w-[480px] flex-col gap-6">
      <PageMetadata title={pageTitle(t('agentAuth.access'))} noIndex />
      <div className="flex flex-col gap-5 rounded-lg border bg-card p-5 sm:p-8">{children}</div>
    </div>
  );
}

function Notice({ message }: { message: string }) {
  return (
    <div role="alert" className="flex flex-col gap-3">
      <CircleAlert className="size-6 text-status-critical" aria-hidden="true" />
      <p className="text-sm text-muted-foreground">{message}</p>
    </div>
  );
}

function ConsentForm({
  requestId,
  view,
  currentWorkspaceId,
}: {
  requestId: string;
  view: ConsentView;
  currentWorkspaceId: string | null;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const [choice, setChoice] = useState<ConsentChoice>(() =>
    initialChoice(view, currentWorkspaceId),
  );
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const workspace = view.workspaces.find((entry) => entry.id === choice.workspaceId);
  const { allowed } = scopesFor(view, choice.workspaceId);
  const atCap = workspace?.atCap === true;
  const canAllow =
    !busy &&
    !atCap &&
    workspace !== undefined &&
    choice.scopes.length > 0 &&
    choice.name.trim() !== '';

  const leave = async (action: () => Promise<{ data: { redirectTo: string } }>) => {
    setBusy(true);
    setError(null);
    try {
      const { redirectTo } = (await action()).data;
      window.location.assign(redirectTo);
    } catch (err) {
      setError(errorMessage(t, err, 'agentAuth.failed'));
      setBusy(false);
    }
  };

  const allow = () =>
    leave(() =>
      approveConsent(requestId, {
        workspaceId: choice.workspaceId,
        scopes: choice.scopes,
        name: choice.name.trim(),
      }),
    );
  const deny = () => leave(() => denyConsent(requestId));

  if (view.workspaces.length === 0) {
    return (
      <>
        <Notice message={t('agentAuth.noWorkspaces')} />
        <Button className="h-10 self-start px-5" disabled={busy} onClick={() => void deny()}>
          {t('agentAuth.deny')}
        </Button>
      </>
    );
  }

  return (
    <>
      <div className="flex flex-col gap-2">
        <div className="flex size-11 items-center justify-center rounded-full bg-sunken text-muted-foreground">
          <Bot className="size-5" aria-hidden="true" />
        </div>
        <h1 className="text-xl leading-tight font-semibold">
          {t('agentAuth.title', { client: view.clientName })}
        </h1>
        <p className="text-sm text-muted-foreground">
          {t('agentAuth.returnsTo', { host: view.redirectHost })}
        </p>
      </div>
      {error === null ? null : <FormError>{error}</FormError>}
      <div className="flex flex-col gap-1.5">
        <label id="agent-auth-workspace" className="text-sm font-medium">
          {t('agentAuth.workspace')}
        </label>
        <SelectField
          aria-labelledby="agent-auth-workspace"
          value={choice.workspaceId}
          disabled={busy}
          options={view.workspaces.map((entry) => ({ value: entry.id, label: entry.name }))}
          onValueChange={(workspaceId) => {
            setChoice((prev) => ({
              ...prev,
              workspaceId,
              scopes: [...scopesFor(view, workspaceId).preselected],
            }));
          }}
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor="agent-auth-name" className="text-sm font-medium">
          {t('agentAuth.name')}
        </label>
        <Input
          id="agent-auth-name"
          value={choice.name}
          disabled={busy}
          maxLength={NAME_MAX}
          autoComplete="off"
          onChange={(event) => {
            setChoice((prev) => ({ ...prev, name: event.target.value }));
          }}
        />
        <p className="text-[13px] text-muted-foreground">{t('agentAuth.nameHint')}</p>
      </div>
      <fieldset className="flex flex-col gap-2">
        <legend className="text-sm font-medium">{t('agentAuth.access')}</legend>
        <p className="mb-1 text-[13px] text-muted-foreground">{t('agentAuth.roleNote')}</p>
        {allowed.map((scope) => {
          const id = `agent-auth-scope-${scope}`;
          return (
            <div key={scope} className="flex items-start gap-2.5">
              <Checkbox
                id={id}
                checked={choice.scopes.includes(scope)}
                disabled={busy}
                className="mt-0.5"
                onCheckedChange={(checked) => {
                  setChoice((prev) => ({
                    ...prev,
                    scopes:
                      checked === true
                        ? [...prev.scopes, scope]
                        : prev.scopes.filter((entry) => entry !== scope),
                  }));
                }}
              />
              <label htmlFor={id} className="flex flex-col text-sm leading-snug">
                <span className="font-medium">{t(`agentKeys.scopes.${scopeKey(scope)}.name`)}</span>
                <span className="text-[13px] text-muted-foreground">
                  {t(`agentKeys.scopes.${scopeKey(scope)}.hint`)}
                </span>
              </label>
            </div>
          );
        })}
      </fieldset>
      {atCap ? (
        <div role="alert" className="flex flex-col gap-1 text-sm text-muted-foreground">
          <p>{t('agentAuth.atCap')}</p>
          <Link
            to={pathTo(ROUTES.AGENT_KEYS, language)}
            className="font-medium text-foreground underline"
          >
            {t('agentAuth.agentKeysLink')}
          </Link>
        </div>
      ) : null}
      <div className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
        <Button variant="outline" className="h-10 px-5" disabled={busy} onClick={() => void deny()}>
          {t('agentAuth.deny')}
        </Button>
        <Button className="h-10 px-5" disabled={!canAllow} onClick={() => void allow()}>
          {t('agentAuth.allow')}
        </Button>
      </div>
      <p className="text-[13px] text-muted-foreground">{t('agentAuth.revokeNote')}</p>
    </>
  );
}

/**
 * An agent (an MCP client) asks to sign in: `authorize-agent?request=<id>`. The member picks the
 * workspace, a name and the scopes their role allows, then goes back to the agent with
 * `window.location.assign` (the redirect may leave this origin). Signed-out visitors log in first
 * and return with the query intact (ProtectedRoute `next`).
 */
export default function AuthorizeAgentPage() {
  const { t } = useTranslation();
  const [params] = useSearchParams();
  const requestId = params.get('request') ?? '';
  const current = useCurrentWorkspace();
  const query = useQuery({
    queryKey: ['mcp-oauth-consent', requestId],
    queryFn: async ({ signal }) =>
      (await getConsent(requestId, { signal, suppressErrorToast: true })).data,
    enabled: requestId !== '',
    retry: false,
    staleTime: Infinity,
    gcTime: 0,
  });

  const expired =
    requestId === '' ||
    (query.isError &&
      apiErrorStatus(query.error) === 404 &&
      apiErrorCode(query.error) === 'request_expired');

  let body: React.ReactNode;
  if (expired) {
    body = <Notice message={t('agentAuth.expired')} />;
  } else if (query.isError) {
    body = <Notice message={errorMessage(t, query.error, 'agentAuth.failed')} />;
  } else if (query.data === undefined || current.isLoading) {
    body = (
      <div className="flex flex-col gap-3" aria-busy="true">
        <Skeleton className="h-6 w-3/4" />
        <Skeleton className="h-10 w-full" />
        <Skeleton className="h-10 w-full" />
      </div>
    );
  } else {
    body = (
      <ConsentForm
        requestId={requestId}
        view={query.data}
        currentWorkspaceId={current.workspace?.id ?? null}
      />
    );
  }
  return <Frame>{body}</Frame>;
}
