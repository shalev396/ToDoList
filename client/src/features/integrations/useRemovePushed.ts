import { useState } from 'react';
import { useTranslation } from 'react-i18next';
import { cleanupProgressOf, errorMessage } from '@/api/errors';
import type { CleanupProgress } from '@api-types/api-contracts';
import {
  useIntegrations,
  usePrimaryCalendar,
  useRemovePushedEvents,
} from '@/api/queries/integrations';

/** How a "remove the events TodoList added" run ended. */
export type CleanupOutcome =
  | { kind: 'done'; events: number }
  | { kind: 'incomplete'; progress: CleanupProgress }
  | { kind: 'error'; message: string };

/**
 * Runs the removal of the events pushed with one Google Calendar connection. Out of time is not a
 * failure: the outcome carries the progress, and `run` again continues.
 */
export function useRemovePushed(workspaceId: string) {
  const { t } = useTranslation();
  const remove = useRemovePushedEvents(workspaceId);
  const [outcome, setOutcome] = useState<CleanupOutcome | null>(null);

  const run = async (integrationId: string): Promise<CleanupOutcome> => {
    let next: CleanupOutcome;
    try {
      const data = await remove.mutateAsync(integrationId);
      next = { kind: 'done', events: data.events };
    } catch (failure) {
      const progress = cleanupProgressOf(failure);
      next =
        progress === null
          ? { kind: 'error', message: errorMessage(t, failure, 'connect.pushed.error') }
          : { kind: 'incomplete', progress };
    }
    setOutcome(next);
    return next;
  };

  return { outcome, run, pending: remove.isPending };
}

/**
 * The connection the workspace calendar is on now, when its events can be removed after a change:
 * it is mine and read & write. Null otherwise.
 */
export function useRemovableOldPrimary(workspaceId: string): string | null {
  const primary = usePrimaryCalendar(workspaceId);
  const integrations = useIntegrations(workspaceId);
  const view = primary.data;
  if (view === undefined || !view.mine || view.integrationId === null) {
    return null;
  }
  const old = integrations.data?.find((entry) => entry.id === view.integrationId);
  return old?.mode === 'read_write' ? old.id : null;
}
