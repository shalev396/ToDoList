import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleAlert, KeyRound, Plus } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import { baseURL } from '@/api/instance';
import { useAgentKeys, useRefreshAgentKeys, useRevokeAgentKey } from '@/api/queries/agentKeys';
import { createAgentKey } from '@/api/services/agentKeyService';
import { FormError } from '@/components/auth/auth-ui';
import { dateLocale } from '@/components/items/format';
import { PageMetadata } from '@/components/shared/PageMetadata';
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
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { Skeleton } from '@/components/ui/skeleton';
import { pageTitle } from '@/data/pageTitles';
import { CopyField } from '@/features/integrations/CopyField';
import { EmptyIcon, EmptyState } from '@/features/shell/EmptyState';
import { useCurrentWorkspace } from '@/features/workspaces/useCurrentWorkspace';
import { useLanguage } from '@/hooks/useLanguage';
import { SettingsFrame, SettingsSection } from '@/pages/settings/SettingsLayout';
import type { AgentKeyView, WorkspaceView } from '@api-types/api-contracts';
import { AGENT_SCOPES, type AgentScope } from '@api-types/domain';

/**
 * This stage's MCP endpoints (MCP.md §12): the API the app itself calls, so dev, QA, prod and a
 * local server each show their own address with nothing configured.
 */
const MCP_URL = `${baseURL}/mcp`;
const MCP_READONLY_URL = `${MCP_URL}/readonly`;

/** i18n keys can't hold the scope's colon. */
const scopeKey = (scope: AgentScope) => scope.replace(':', '_');

const MAX_DAYS = 365;
const DEFAULT_DAYS = 90;

/** Scopes that change data; the dialog points them out. */
const WRITE_SCOPES: ReadonlySet<AgentScope> = new Set([
  'items:write',
  'sync',
  'gcal:write',
  'providers:create',
  'integrations:connect',
  'workspace:share',
  'builder:write',
  'builder:publish',
]);

interface CreateKeyDialogProps {
  workspace: WorkspaceView;
  onClose: () => void;
}

/**
 * New agent key: name, scopes, expiry. The raw key comes back once, in the create answer; it is
 * held in this dialog's state only (not a mutation, so no cache keeps it) and dropped when the
 * owner confirms they stored it.
 */
function CreateKeyDialog({ workspace, onClose }: CreateKeyDialogProps) {
  const { t } = useTranslation();
  const refresh = useRefreshAgentKeys(workspace.id);
  const [name, setName] = useState('');
  const [scopes, setScopes] = useState<AgentScope[]>(['read']);
  const [days, setDays] = useState(String(DEFAULT_DAYS));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [rawKey, setRawKey] = useState<string | null>(null);

  const submit = async (event: React.FormEvent) => {
    event.preventDefault();
    const expiresInDays = Number(days);
    if (
      name.trim() === '' ||
      scopes.length === 0 ||
      !Number.isInteger(expiresInDays) ||
      expiresInDays < 1 ||
      expiresInDays > MAX_DAYS
    ) {
      setError(t('agentKeys.create.invalid', { max: MAX_DAYS }));
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const created = await createAgentKey(
        workspace.id,
        { name: name.trim(), scopes, expiresInDays },
        { suppressErrorToast: true },
      );
      setRawKey(created.data.key);
      await refresh();
    } catch (failure) {
      setError(errorMessage(t, failure, 'agentKeys.create.failed'));
    } finally {
      setBusy(false);
    }
  };

  const close = () => {
    setRawKey(null);
    onClose();
  };

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        // Once the key is shown, only the explicit "stored it" button closes: no accidental loss.
        if (!open && rawKey === null) {
          close();
        }
      }}
    >
      <DialogContent
        className="max-h-[90dvh] overflow-y-auto sm:max-w-lg"
        onInteractOutside={(event) => {
          if (rawKey !== null) {
            event.preventDefault();
          }
        }}
        onEscapeKeyDown={(event) => {
          if (rawKey !== null) {
            event.preventDefault();
          }
        }}
      >
        <DialogHeader>
          <DialogTitle>
            {t(rawKey === null ? 'agentKeys.create.title' : 'agentKeys.shown.title')}
          </DialogTitle>
          <DialogDescription>
            {t(rawKey === null ? 'agentKeys.create.description' : 'agentKeys.shown.description')}
          </DialogDescription>
        </DialogHeader>
        {rawKey === null ? (
          <form onSubmit={(event) => void submit(event)} className="flex flex-col gap-4" noValidate>
            {error === null ? null : <FormError>{error}</FormError>}
            <div className="flex flex-col gap-1.5">
              <label htmlFor="agent-key-name" className="text-sm font-medium">
                {t('agentKeys.create.name')}
              </label>
              <Input
                id="agent-key-name"
                value={name}
                maxLength={80}
                autoComplete="off"
                placeholder={t('agentKeys.create.namePlaceholder')}
                onChange={(event) => {
                  setName(event.target.value);
                }}
              />
            </div>
            <fieldset className="flex flex-col gap-2">
              <legend className="mb-1 text-sm font-medium">{t('agentKeys.create.scopes')}</legend>
              {AGENT_SCOPES.map((scope) => {
                const id = `agent-scope-${scope}`;
                return (
                  <div key={scope} className="flex items-start gap-2.5">
                    <Checkbox
                      id={id}
                      checked={scopes.includes(scope)}
                      className="mt-0.5"
                      onCheckedChange={(checked) => {
                        setScopes(
                          checked === true
                            ? [...scopes, scope]
                            : scopes.filter((entry) => entry !== scope),
                        );
                      }}
                    />
                    <label htmlFor={id} className="flex flex-col text-sm leading-snug">
                      <span className="font-medium">
                        {t(`agentKeys.scopes.${scopeKey(scope)}.name`)}
                      </span>
                      <span className="text-[13px] text-muted-foreground">
                        {t(`agentKeys.scopes.${scopeKey(scope)}.hint`)}
                        {WRITE_SCOPES.has(scope) ? ` ${t('agentKeys.create.writes')}` : ''}
                      </span>
                    </label>
                  </div>
                );
              })}
            </fieldset>
            <div className="flex max-w-44 flex-col gap-1.5">
              <label htmlFor="agent-key-days" className="text-sm font-medium">
                {t('agentKeys.create.expires')}
              </label>
              <Input
                id="agent-key-days"
                type="number"
                min={1}
                max={MAX_DAYS}
                inputMode="numeric"
                value={days}
                onChange={(event) => {
                  setDays(event.target.value);
                }}
              />
              <p className="text-[13px] text-muted-foreground">
                {t('agentKeys.create.expiresHint', { max: MAX_DAYS })}
              </p>
            </div>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={close}>
                {t('connect.cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {t(busy ? 'connect.dialog.saving' : 'agentKeys.create.submit')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <CopyField name="agentKey" label={t('agentKeys.shown.label')} value={rawKey} />
            <p className="text-[13px] text-muted-foreground">{t('agentKeys.shown.note')}</p>
            <DialogFooter>
              <Button type="button" onClick={close}>
                {t('agentKeys.shown.stored')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}

function KeyRow({
  agentKey,
  onRevoke,
}: {
  agentKey: AgentKeyView;
  onRevoke: (key: AgentKeyView) => void;
}) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const { workspace } = useCurrentWorkspace();
  const format = (value: string | Date | null, empty: string) =>
    value === null
      ? empty
      : new Intl.DateTimeFormat(dateLocale(language), {
          dateStyle: 'medium',
          ...(workspace === null ? {} : { timeZone: workspace.settings.timezone }),
        }).format(new Date(value));
  const revoked = agentKey.revokedAt !== null;
  return (
    <li
      data-agent-key={agentKey.name}
      data-revoked={revoked ? 'true' : undefined}
      className="flex flex-col gap-2 border-t py-4 first:border-t-0 first:pt-0"
    >
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <h3 className="text-sm font-semibold break-words" dir="auto">
          {agentKey.name}
        </h3>
        <code className="text-[13px] text-muted-foreground" dir="ltr">
          {agentKey.prefix}…
        </code>
        {revoked ? (
          <span className="text-[13px] text-destructive">
            {t('agentKeys.list.revoked', { date: format(agentKey.revokedAt, '') })}
          </span>
        ) : (
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="ms-auto text-destructive max-md:h-11"
            onClick={() => {
              onRevoke(agentKey);
            }}
          >
            {t('agentKeys.list.revoke')}
          </Button>
        )}
      </div>
      <ul className="flex flex-wrap gap-1.5" aria-label={t('agentKeys.list.scopes')}>
        {agentKey.scopes.map((scope) => (
          <li key={scope} className="rounded-sm bg-sunken px-1.5 py-0.5 text-[12px]" dir="ltr">
            {scope}
          </li>
        ))}
      </ul>
      <p className="text-[13px] text-muted-foreground">
        {t('agentKeys.list.expires', {
          date: format(agentKey.expiresAt, t('agentKeys.list.never')),
        })}
        {', '}
        {t('agentKeys.list.lastUsed', {
          date: format(agentKey.lastUsedAt, t('agentKeys.list.neverUsed')),
        })}
      </p>
    </li>
  );
}

function Keys({ workspace, isOwner }: { workspace: WorkspaceView; isOwner: boolean }) {
  const { t } = useTranslation();
  const keys = useAgentKeys(workspace.id);
  const revoke = useRevokeAgentKey(workspace.id);
  const [creating, setCreating] = useState(false);
  const [revoking, setRevoking] = useState<AgentKeyView | null>(null);
  const [problem, setProblem] = useState<string | null>(null);

  return (
    <SettingsSection
      id="agent-keys-title"
      title={t('agentKeys.title')}
      hint={t('agentKeys.hint')}
      layout="stacked"
    >
      {isOwner ? (
        <div>
          <Button
            type="button"
            onClick={() => {
              setCreating(true);
            }}
          >
            <Plus aria-hidden="true" />
            {t('agentKeys.create.open')}
          </Button>
        </div>
      ) : null}
      {problem === null ? null : <FormError>{problem}</FormError>}
      {keys.data === undefined ? (
        keys.isError ? (
          <EmptyState
            visual={
              <EmptyIcon>
                <CircleAlert aria-hidden="true" />
              </EmptyIcon>
            }
            title={t('agentKeys.loadError')}
            body={t('connect.loadErrorBody')}
            action={
              <Button
                variant="outline"
                onClick={() => {
                  void keys.refetch();
                }}
              >
                {t('dashboard.retry')}
              </Button>
            }
          />
        ) : (
          <Skeleton className="h-24 rounded-lg" />
        )
      ) : keys.data.length === 0 ? (
        <EmptyState
          visual={
            <EmptyIcon>
              <KeyRound aria-hidden="true" />
            </EmptyIcon>
          }
          title={t('agentKeys.emptyTitle')}
          body={t(isOwner ? 'agentKeys.emptyBody' : 'agentKeys.emptyBodyViewer')}
        />
      ) : (
        <ul>
          {keys.data.map((agentKey) => (
            <KeyRow key={agentKey.id} agentKey={agentKey} onRevoke={setRevoking} />
          ))}
        </ul>
      )}
      {creating ? (
        <CreateKeyDialog
          workspace={workspace}
          onClose={() => {
            setCreating(false);
          }}
        />
      ) : null}
      <AlertDialog
        open={revoking !== null}
        onOpenChange={(open) => {
          if (!open) {
            setRevoking(null);
          }
        }}
      >
        <AlertDialogContent>
          <AlertDialogHeader>
            <AlertDialogTitle>
              {t('agentKeys.revoke.title', { name: revoking?.name ?? '' })}
            </AlertDialogTitle>
            <AlertDialogDescription>{t('agentKeys.revoke.body')}</AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogCancel>{t('connect.cancel')}</AlertDialogCancel>
            <AlertDialogAction
              onClick={() => {
                if (revoking === null) {
                  return;
                }
                setProblem(null);
                revoke.mutate(revoking.id, {
                  onError: (failure) => {
                    setProblem(errorMessage(t, failure, 'agentKeys.revoke.failed'));
                  },
                });
              }}
            >
              {t('agentKeys.list.revoke')}
            </AlertDialogAction>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </SettingsSection>
  );
}

/** Where an agent connects: the address the TodoList plugin and other MCP clients ask for. */
function ConnectAgent() {
  const { t } = useTranslation();
  return (
    <SettingsSection
      id="agent-connect-title"
      title={t('settings.mcp.title')}
      hint={t('settings.mcp.hint')}
      layout="stacked"
    >
      <CopyField name="mcpUrl" label={t('settings.mcp.address')} value={MCP_URL} />
      <CopyField
        name="mcpReadonlyUrl"
        label={t('settings.mcp.readonly')}
        value={MCP_READONLY_URL}
      />
      <p className="text-[13px] text-muted-foreground">{t('settings.mcp.howTo')}</p>
    </SettingsSection>
  );
}

/** Keys for AI agents (MCP.md §4): the owner creates and revokes; members see their own. */
export default function AgentKeysPage() {
  const { t } = useTranslation();
  const { workspace, isOwner } = useCurrentWorkspace();
  if (workspace === null) {
    return null;
  }
  return (
    <SettingsFrame>
      <PageMetadata title={pageTitle(t('agentKeys.title'))} noIndex />
      <Keys key={workspace.id} workspace={workspace} isOwner={isOwner} />
      <ConnectAgent />
    </SettingsFrame>
  );
}
