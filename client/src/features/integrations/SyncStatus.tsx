import { useTranslation } from 'react-i18next';
import { CircleAlert, CircleCheck, LoaderCircle } from 'lucide-react';
import type { SyncRunView } from '@api-types/integrations';
import { isRunActive } from './status';

const COUNT_KEYS = ['fetched', 'inserted', 'updated', 'deleted', 'failed'] as const;

/** A run's state, counts and sanitized error: all text from i18n or numbers. */
export function SyncStatus({ run }: { run: SyncRunView }) {
  const { t } = useTranslation();
  const active = isRunActive(run);
  const failed = run.status === 'failed' || run.status === 'partial';
  const Icon = active ? LoaderCircle : failed ? CircleAlert : CircleCheck;
  const counts = COUNT_KEYS.filter((key) => (run.counts[key] ?? 0) > 0);
  return (
    <div
      data-sync-status={run.status}
      className="flex flex-col gap-0.5 text-[13px] text-muted-foreground"
    >
      <p role="status" className="flex items-center gap-1.5">
        <Icon
          aria-hidden="true"
          className={active ? 'size-3.5 animate-spin motion-reduce:animate-none' : 'size-3.5'}
        />
        <span className={failed ? 'text-destructive' : 'text-foreground'}>
          {t(`connect.run.${run.status}`)}
        </span>
      </p>
      {active || counts.length === 0 ? null : (
        <p>
          {counts
            .map((key) => t(`connect.run.counts.${key}`, { n: run.counts[key] ?? 0 }))
            .join(', ')}
        </p>
      )}
      {run.error === null ? null : (
        <p className="text-destructive">
          {t(`connect.testCodes.${run.error.code}`, {
            defaultValue: t('connect.run.unknownError'),
          })}
        </p>
      )}
    </div>
  );
}
