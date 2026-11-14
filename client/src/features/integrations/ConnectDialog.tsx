import { useId, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { CircleCheck, ExternalLink } from 'lucide-react';
import { errorMessage } from '@/api/errors';
import {
  useCreateIntegration,
  useIntegrationSyncRuns,
  useRefreshIntegrations,
  useSyncIntegration,
  useTestIntegration,
} from '@/api/queries/integrations';
import { saveCredential } from '@/api/services/integrationService';
import { FormError } from '@/components/auth/auth-ui';
import { Button } from '@/components/ui/button';
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog';
import { Input } from '@/components/ui/input';
import { SelectField } from '@/components/ui/select';
import type {
  CreateIntegrationRequestBody,
  SaveCredentialRequestBody,
} from '@api-types/api-contracts';
import type { ConnectableProvider, IntegrationTestResult } from '@api-types/integrations';
import {
  bodyFrom,
  configFields,
  credentialFields,
  missingFields,
  PROVIDER_REGISTRY,
} from './providers';
import { SecretField } from './SecretField';
import { takeFormValues } from './secrets';
import { SyncStatus } from './SyncStatus';
import { latestRun } from './status';

interface ConnectDialogProps {
  workspaceId: string;
  provider: ConnectableProvider;
  /** Replacing the credentials of this integration instead of connecting a new account. */
  existingId?: string | undefined;
  onClose: () => void;
}

type Phase = 'form' | 'saved';

/**
 * Connect a source (FRONTEND.md §8): its settings and secrets in one form. Submit creates the
 * integration (`POST`, settings only), then `PUT …/credential` with the secrets, which are read
 * from the inputs once and emptied before the request leaves. Then Test connection and Sync now.
 */
export function ConnectDialog({ workspaceId, provider, existingId, onClose }: ConnectDialogProps) {
  const { t } = useTranslation();
  const formId = useId();
  const spec = PROVIDER_REGISTRY[provider];
  const cfgFields = existingId === undefined ? configFields(provider) : [];
  const credFields = credentialFields(provider);
  const secretNames = credFields.filter((field) => field.secret).map((field) => field.name);
  const plainFields = credFields.filter((field) => !field.secret);
  const [plain, setPlain] = useState<Record<string, string>>({});
  const [phase, setPhase] = useState<Phase>('form');
  const [integrationId, setIntegrationId] = useState<string | null>(existingId ?? null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [missing, setMissing] = useState<string[]>([]);
  const [test, setTest] = useState<IntegrationTestResult | null>(null);
  const create = useCreateIntegration(workspaceId);
  const testConnection = useTestIntegration(workspaceId);
  const syncNow = useSyncIntegration(workspaceId);
  const refresh = useRefreshIntegrations(workspaceId);
  const runs = useIntegrationSyncRuns(workspaceId);
  const run = integrationId === null ? undefined : latestRun(runs.data, integrationId);
  const name = t(`sources.${provider}`);
  const labelOf = (field: string) => t(`connect.fields.${field}`);

  const submit = async (event: React.FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const form = event.currentTarget;
    const lookup = (field: string) => form.elements.namedItem(field) as HTMLInputElement | null;
    // A select shows its first option before it is touched: that is its value.
    const configValues = Object.fromEntries(
      cfgFields.map((field) => [field.name, plain[field.name] ?? field.options?.[0] ?? '']),
    );
    const emptySecrets = secretNames.filter((field) => (lookup(field)?.value.trim() ?? '') === '');
    const absent = [
      ...missingFields(cfgFields, configValues),
      ...missingFields(
        credFields.filter((field) => !field.secret),
        plain,
      ),
      ...credFields
        .filter((field) => field.secret && field.required && emptySecrets.includes(field.name))
        .map((field) => field.name),
    ];
    setMissing(absent);
    if (absent.length > 0) {
      setError(t('connect.dialog.fillRequired'));
      return;
    }
    // Secrets are read and emptied now, in this tick; only the body below holds them.
    const secrets = takeFormValues(lookup, secretNames);
    const values = { ...plain, ...secrets };
    setBusy(true);
    setError(null);
    try {
      let id = integrationId;
      if (id === null) {
        const created = await create.mutateAsync({
          provider,
          config: bodyFrom(cfgFields, configValues),
        } as unknown as CreateIntegrationRequestBody);
        id = created.id;
        setIntegrationId(id);
      }
      await saveCredential(
        workspaceId,
        id,
        bodyFrom(credFields, values) as unknown as SaveCredentialRequestBody,
      );
      await refresh();
      setPhase('saved');
    } catch (failure) {
      setError(
        errorMessage(
          t,
          failure,
          integrationId === null && secretNames.length > 0
            ? 'connect.dialog.failed'
            : 'connect.dialog.credentialFailed',
        ),
      );
    } finally {
      setBusy(false);
    }
  };

  const runTest = async () => {
    if (integrationId === null) {
      return;
    }
    try {
      setTest(await testConnection.mutateAsync(integrationId));
    } catch (failure) {
      setError(errorMessage(t, failure, 'connect.card.testError'));
    }
  };

  const runSync = async () => {
    if (integrationId === null) {
      return;
    }
    try {
      await syncNow.mutateAsync(integrationId);
    } catch (failure) {
      setError(errorMessage(t, failure, 'connect.card.syncError'));
    }
  };

  const secretHint = (field: string): string | undefined =>
    provider === 'github' && field === 'token'
      ? t('connect.hints.githubToken')
      : provider === 'github' && field === 'projectsToken'
        ? t('connect.hints.githubProjectsToken')
        : undefined;

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) {
          onClose();
        }
      }}
    >
      <DialogContent className="max-h-[90dvh] overflow-y-auto sm:max-w-lg">
        <DialogHeader>
          <DialogTitle>
            {t(existingId === undefined ? 'connect.dialog.title' : 'connect.dialog.replaceTitle', {
              name,
            })}
          </DialogTitle>
          <DialogDescription>{t('connect.dialog.description')}</DialogDescription>
        </DialogHeader>
        {error === null ? null : <FormError>{error}</FormError>}
        {phase === 'form' ? (
          <form
            id={formId}
            onSubmit={(event) => void submit(event)}
            autoComplete="off"
            className="flex flex-col gap-4"
            noValidate
          >
            {cfgFields.map((field) => {
              const id = `${formId}-${field.name}`;
              return (
                <div key={field.name} className="flex flex-col gap-1.5">
                  <label htmlFor={id} className="text-sm font-medium">
                    {labelOf(field.name)}
                    {field.required ? null : (
                      <span className="ms-1 font-normal text-muted-foreground">
                        {t('connect.dialog.optional')}
                      </span>
                    )}
                  </label>
                  {field.input === 'select' ? (
                    <SelectField
                      id={id}
                      value={plain[field.name] ?? field.options?.[0] ?? ''}
                      onValueChange={(next) => {
                        setPlain({ ...plain, [field.name]: next });
                      }}
                      options={(field.options ?? []).map((option) => ({
                        value: option,
                        label: t(`connect.options.${option}`),
                      }))}
                    />
                  ) : (
                    <Input
                      id={id}
                      name={field.name}
                      type={field.input === 'url' ? 'url' : 'text'}
                      dir="ltr"
                      autoComplete="off"
                      className="text-start"
                      aria-invalid={missing.includes(field.name) ? true : undefined}
                      value={plain[field.name] ?? ''}
                      onChange={(event) => {
                        setPlain({ ...plain, [field.name]: event.target.value });
                      }}
                    />
                  )}
                </div>
              );
            })}
            {plainFields.map((field) => {
              const id = `${formId}-${field.name}`;
              return (
                <div key={field.name} className="flex flex-col gap-1.5">
                  <label htmlFor={id} className="text-sm font-medium">
                    {labelOf(field.name)}
                  </label>
                  <Input
                    id={id}
                    name={field.name}
                    dir="ltr"
                    autoComplete="off"
                    className="text-start"
                    aria-invalid={missing.includes(field.name) ? true : undefined}
                    value={plain[field.name] ?? ''}
                    onChange={(event) => {
                      setPlain({ ...plain, [field.name]: event.target.value });
                    }}
                  />
                </div>
              );
            })}
            {credFields
              .filter((field) => field.secret)
              .map((field) => (
                <SecretField
                  key={field.name}
                  name={field.name}
                  label={labelOf(field.name)}
                  hint={secretHint(field.name)}
                  required={field.required}
                  multiline={field.multiline}
                  invalid={missing.includes(field.name)}
                  disabled={busy}
                />
              ))}
            <p className="text-[13px] text-muted-foreground">{t('connect.dialog.secretNote')}</p>
            <a
              href={spec.docsUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex w-fit items-center gap-1 text-[13px] underline underline-offset-2"
            >
              {t('connect.card.docs')}
              <ExternalLink aria-hidden="true" className="size-3.5" />
            </a>
            <DialogFooter>
              <Button type="button" variant="ghost" onClick={onClose}>
                {t('connect.cancel')}
              </Button>
              <Button type="submit" disabled={busy}>
                {t(busy ? 'connect.dialog.saving' : 'connect.dialog.save')}
              </Button>
            </DialogFooter>
          </form>
        ) : (
          <div className="flex flex-col gap-4">
            <p className="flex items-center gap-2 text-sm font-medium">
              <CircleCheck aria-hidden="true" className="size-4" />
              {t('connect.dialog.saved')}
            </p>
            <div className="flex flex-wrap items-center gap-2">
              <Button
                type="button"
                variant="outline"
                disabled={testConnection.isPending}
                onClick={() => void runTest()}
              >
                {t('connect.card.test')}
              </Button>
              <Button
                type="button"
                variant="outline"
                disabled={syncNow.isPending || test?.ok !== true}
                onClick={() => void runSync()}
              >
                {t('connect.card.sync')}
              </Button>
            </div>
            {test === null ? null : (
              <p role="status" data-test-result={test.ok ? 'ok' : test.code} className="text-sm">
                {test.ok
                  ? t('connect.card.testOk', { label: test.accountLabel })
                  : t(`connect.testCodes.${test.code}`)}
              </p>
            )}
            {run === undefined ? null : <SyncStatus run={run} />}
            <DialogFooter>
              <Button type="button" onClick={onClose}>
                {t('connect.done')}
              </Button>
            </DialogFooter>
          </div>
        )}
      </DialogContent>
    </Dialog>
  );
}
