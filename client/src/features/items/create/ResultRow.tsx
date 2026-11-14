import { useTranslation } from 'react-i18next';
import { Check, CircleAlert, CircleHelp, ExternalLink, Loader2 } from 'lucide-react';
import { SourceDot } from '@/components/items/SourceDot';
import { Button } from '@/components/ui/button';
import type { CreateFailure } from '@api-types/providerCreate.ts';
import type { Result } from './useCopyRunner';

const FAILURE_KEYS: Readonly<Record<CreateFailure, string>> = {
  rejected: 'items.newTodo.results.rejected',
  auth_failed: 'items.newTodo.results.authFailed',
  rate_limited: 'items.newTodo.results.rateLimited',
  unreachable: 'items.newTodo.results.unreachable',
  token_cannot_create: 'items.newTodo.results.tokenCannot',
  bad_target: 'items.newTodo.results.badTarget',
  needs_due_date: 'items.newTodo.results.needsDue',
};

/** A link a provider sent: only https is ever an href. */
const safeHref = (url: string): string | null => (url.startsWith('https://') ? url : null);

/** One target's row: where it stands, and what to do about it. */
export function ResultRow({
  result,
  onRetry,
  onAllow,
}: {
  result: Result;
  onRetry: () => void;
  onAllow: () => void;
}) {
  const { t } = useTranslation();
  const source = t(`sources.${result.provider}`);
  const { phase } = result;
  const wrap = 'flex min-w-0 flex-col gap-1 rounded-md border p-3 text-sm';
  const head = (icon: React.ReactNode, text: string) => (
    <div className="flex items-center gap-2">
      {icon}
      <span className="min-w-0 flex-1">{text}</span>
    </div>
  );
  if (phase.kind === 'pending') {
    return (
      <li className={wrap} data-result={result.provider} data-result-state="pending">
        {head(
          <Loader2 className="size-4 animate-spin text-muted-foreground" aria-hidden="true" />,
          t('items.newTodo.results.pending', { source }),
        )}
      </li>
    );
  }
  if (phase.kind === 'error') {
    return (
      <li className={wrap} data-result={result.provider} data-result-state="failed" role="alert">
        {head(
          <CircleAlert className="size-4 text-destructive" aria-hidden="true" />,
          phase.message,
        )}
        <Button type="button" size="sm" variant="outline" className="self-start" onClick={onRetry}>
          {t('items.newTodo.results.retry')}
        </Button>
      </li>
    );
  }
  const { outcome } = phase;
  if (outcome.status === 'created') {
    const { key, url } = outcome.copy;
    const href = safeHref(url);
    return (
      <li className={wrap} data-result={result.provider} data-result-state="created">
        {head(
          <Check className="size-4 text-primary" aria-hidden="true" />,
          key === null
            ? t('items.newTodo.results.created', { source })
            : t('items.newTodo.results.createdKey', { source, key }),
        )}
        {href === null ? null : (
          <a
            href={href}
            target="_blank"
            rel="noopener noreferrer"
            className="inline-flex items-center gap-1 self-start text-primary underline-offset-4 hover:underline"
            data-result-link=""
          >
            {t('items.newTodo.results.open')}
            <ExternalLink className="size-3.5" aria-hidden="true" />
          </a>
        )}
      </li>
    );
  }
  if (outcome.status === 'unknown') {
    const href = safeHref(outcome.copy.url);
    return (
      <li className={wrap} data-result={result.provider} data-result-state="unknown" role="alert">
        {head(
          <CircleHelp className="size-4 text-destructive" aria-hidden="true" />,
          t('items.newTodo.results.unknown', { source }),
        )}
        {result.confirming ? (
          <p className="text-destructive" data-retry-warning="">
            {t('items.newTodo.results.retryWarn', { source })}
          </p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          {href === null ? null : (
            <a
              href={href}
              target="_blank"
              rel="noopener noreferrer"
              className="inline-flex min-h-8 items-center gap-1 text-primary underline-offset-4 hover:underline"
            >
              {t('items.newTodo.results.checkIn', { source })}
              <ExternalLink className="size-3.5" aria-hidden="true" />
            </a>
          )}
          <Button type="button" size="sm" variant="outline" onClick={onRetry} data-retry-anyway="">
            {result.confirming
              ? t('items.newTodo.results.retryConfirm')
              : t('items.newTodo.results.retryAnyway')}
          </Button>
        </div>
      </li>
    );
  }
  if (outcome.status === 'needs_permission') {
    return (
      <li className={wrap} data-result={result.provider} data-result-state="needs_permission">
        {head(
          <SourceDot source={result.provider as 'jira'} />,
          t('items.newTodo.results.needsPermission', { source }),
        )}
        {outcome.kind === 'github_app' ? (
          <>
            <p className="text-muted-foreground">{t('items.newTodo.results.allowGithubHint')}</p>
            {outcome.settingsUrl === null ? null : (
              <a
                href={outcome.settingsUrl}
                target="_blank"
                rel="noopener noreferrer"
                className="inline-flex items-center gap-1 self-start text-primary underline-offset-4 hover:underline"
              >
                {t('items.newTodo.results.allowGithub')}
                <ExternalLink className="size-3.5" aria-hidden="true" />
              </a>
            )}
          </>
        ) : (
          <Button type="button" size="sm" className="self-start" onClick={onAllow} data-allow="">
            {t('items.newTodo.results.allow', { source })}
          </Button>
        )}
      </li>
    );
  }
  return (
    <li className={wrap} data-result={result.provider} data-result-state="failed" role="alert">
      {head(
        <CircleAlert className="size-4 text-destructive" aria-hidden="true" />,
        t(FAILURE_KEYS[outcome.reason], { source }),
      )}
      {outcome.reason === 'token_cannot_create' ? null : (
        <Button type="button" size="sm" variant="outline" className="self-start" onClick={onRetry}>
          {t('items.newTodo.results.retry')}
        </Button>
      )}
    </li>
  );
}
