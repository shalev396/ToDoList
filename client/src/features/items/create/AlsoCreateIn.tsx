import { useEffect, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { Button } from '@/components/ui/button';
import type { ItemDetail } from '@api-types/api-contracts';
import { CopyTargets, type Funnels } from './CopyTargets';
import { isReady } from './funnel';
import { needsRetryWarning, retryAnywayIds } from './retry';
import { ResultRow } from './ResultRow';
import { useCopyRunner } from './useCopyRunner';

/** Set when the user comes back from consenting: the target to select in the sheet. */
export const PRESELECT_KEY = 'todolist-create-preselect';

function readPreselect(): string | null {
  try {
    return sessionStorage.getItem(PRESELECT_KEY);
  } catch {
    return null;
  }
}

function clearPreselect(): void {
  try {
    sessionStorage.removeItem(PRESELECT_KEY);
  } catch {
    /* a convenience */
  }
}

/**
 * "Also create in" for a to-do that exists already (the item sheet): the same chips and funnels
 * as the new to-do sheet, a Create button, and the same results with Retry. `focus` selects one
 * integration at once (Retry on a failed copy, "Retry anyway" on one that may exist).
 */
export function AlsoCreateIn({
  item,
  workspaceId,
  userId,
  focus,
}: {
  item: ItemDetail;
  workspaceId: string;
  userId: string;
  focus: { integrationId: string; anyway: boolean } | null;
}) {
  const { t } = useTranslation();
  const [funnels, setFunnels] = useState<Funnels>({});
  // Back from consenting: read once at mount, then forgotten.
  const [fromConsent] = useState(readPreselect);
  useEffect(() => {
    clearPreselect();
  }, []);
  const preselect = focus?.integrationId ?? fromConsent;
  const [confirmedFor, setConfirmedFor] = useState<string | null>(null);
  // The confirmation belongs to one retry: choosing another one asks again.
  const confirmed = focus !== null && confirmedFor === focus.integrationId;
  const runner = useCopyRunner(workspaceId, userId, () => item.id);

  const selected = Object.values(funnels);
  const focusedFunnel = selected.find((funnel) => funnel.integrationId === focus?.integrationId);
  const warn = needsRetryWarning(
    focus,
    selected.map((funnel) => funnel.integrationId),
    confirmed,
  );
  const unready = selected.some((funnel) => !isReady(funnel, item.dueAt !== null));
  return (
    <section className="flex flex-col gap-3" data-also-create-item="">
      <CopyTargets
        workspaceId={workspaceId}
        userId={userId}
        hasDueDate={item.dueAt !== null}
        isPrivate={item.visibility === 'private'}
        preselect={preselect}
        value={funnels}
        onChange={setFunnels}
      />
      {confirmed && focusedFunnel !== undefined ? (
        <p className="text-sm text-destructive" data-retry-warning="">
          {t('items.newTodo.results.retryWarn', {
            source: t(`sources.${focusedFunnel.provider}`),
          })}
        </p>
      ) : null}
      {selected.length > 0 ? (
        <Button
          type="button"
          size="sm"
          className="self-start"
          disabled={unready || runner.results?.some((r) => r.phase.kind === 'pending') === true}
          data-create-copies=""
          onClick={() => {
            if (warn && focus !== null) {
              setConfirmedFor(focus.integrationId);
              return;
            }
            void runner.run(selected, retryAnywayIds(focus, confirmed));
          }}
        >
          {focus?.anyway === true && confirmed
            ? t('items.newTodo.results.retryConfirm')
            : t('items.newTodo.createHere')}
        </Button>
      ) : null}
      {runner.results === null ? null : (
        <ul className="m-0 flex list-none flex-col gap-2 p-0">
          {runner.results.map((result) => (
            <ResultRow
              key={result.integrationId}
              result={result}
              onRetry={() => {
                runner.retry(result.integrationId);
              }}
              onAllow={() => {
                void runner.allow(result.integrationId);
              }}
            />
          ))}
        </ul>
      )}
    </section>
  );
}
