import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import { Checkbox } from '@/components/ui/checkbox';
import type { CleanupProgress } from '@api-types/primaryCalendar.ts';
import type { CleanupOutcome, CleanupRunner } from './useRemovePushed';

/** What was left alone or refused: events on the current calendar, events Google would not remove. */
export function CleanupCounts({ skipped, failed }: { skipped: number; failed: number }) {
  const { t } = useTranslation();
  return (
    <>
      {failed > 0 ? (
        <p role="status" data-cleanup-failed className="text-[13px] text-destructive">
          {t('connect.pushed.failed', { count: failed })}
        </p>
      ) : null}
      {skipped > 0 ? (
        <p role="status" data-cleanup-skipped className="text-[13px] text-muted-foreground">
          {t('connect.pushed.skipped', { count: skipped })}
        </p>
      ) : null}
    </>
  );
}

/** "Removing… N so far" and Cancel: a clean-up that goes on by itself. */
export function CleanupRunning({ runner }: { runner: CleanupRunner }) {
  const { t } = useTranslation();
  return (
    <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-cleanup-running>
      <p role="status" className="min-w-0 text-[13px]">
        {runner.soFar > 0
          ? t('connect.pushed.removingSoFar', { done: runner.soFar })
          : t('connect.pushed.removing')}
      </p>
      <Button
        type="button"
        size="sm"
        variant="outline"
        className="max-md:h-11"
        data-cleanup-cancel
        onClick={runner.cancel}
      >
        {t('connect.pushed.stop')}
      </Button>
    </div>
  );
}

/** "Removed N; M left" and Continue: a clean-up that stopped early and can go on. */
export function CleanupProgressLine({
  progress,
  pending,
  runner,
  onContinue,
}: {
  progress: CleanupProgress;
  pending: boolean;
  runner?: CleanupRunner;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  if (runner?.running === true) {
    return <CleanupRunning runner={runner} />;
  }
  return (
    <div className="flex flex-col gap-1">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2" data-cleanup-progress>
        <p role="status" className="min-w-0 text-[13px]">
          {t('connect.pushed.progress', {
            events: progress.events,
            remaining: progress.remaining,
          })}
        </p>
        <Button
          type="button"
          size="sm"
          variant="outline"
          className="max-md:h-11"
          data-cleanup-continue
          disabled={pending}
          onClick={onContinue}
        >
          {t('connect.pushed.continue')}
        </Button>
      </div>
      <CleanupCounts skipped={progress.skipped} failed={progress.failed} />
    </div>
  );
}

/** What a finished or stopped removal says: how many went, what is left, or why it failed. */
export function CleanupNote({
  outcome,
  pending,
  runner,
  onContinue,
}: {
  outcome: CleanupOutcome | null;
  pending: boolean;
  runner?: CleanupRunner;
  onContinue: () => void;
}) {
  const { t } = useTranslation();
  if (runner?.running === true) {
    return <CleanupRunning runner={runner} />;
  }
  if (outcome === null) {
    return null;
  }
  if (outcome.kind === 'incomplete') {
    return (
      <CleanupProgressLine progress={outcome.progress} pending={pending} onContinue={onContinue} />
    );
  }
  if (outcome.kind === 'error') {
    return (
      <p role="alert" className="text-[13px] text-destructive">
        {outcome.message}
      </p>
    );
  }
  return (
    <div className="flex flex-col gap-1">
      <p role="status" data-cleanup-done className="text-[13px] text-muted-foreground">
        {t('connect.pushed.done', { count: outcome.events })}
      </p>
      <CleanupCounts skipped={outcome.skipped} failed={outcome.failed} />
    </div>
  );
}

/** Change and Stop: also remove what TodoList added to the calendar being left. */
export function RemoveOldCheckbox({
  id,
  checked,
  onChange,
}: {
  id: string;
  checked: boolean;
  onChange: (checked: boolean) => void;
}) {
  const { t } = useTranslation();
  return (
    <div className="flex min-h-6 items-center gap-2 max-md:min-h-11">
      <Checkbox
        id={id}
        data-remove-old
        checked={checked}
        onCheckedChange={(value) => {
          onChange(value === true);
        }}
      />
      <label htmlFor={id} className="text-sm">
        {t('connect.primary.removeOld')}
      </label>
    </div>
  );
}
