import { useCallback, useEffect, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/errors';
import type { CleanupProgress } from '@api-types/primaryCalendar.ts';
import {
  useIntegrations,
  usePrimaryCalendar,
  useRemovePushedEvents,
} from '@/api/queries/integrations';
import { runCleanup, type CleanupRun } from './cleanupLoop';

/** How a "remove the events TodoList added" run ended. */
export type CleanupOutcome =
  | { kind: 'done'; events: number; skipped: number; failed: number }
  | { kind: 'incomplete'; progress: CleanupProgress }
  | { kind: 'error'; message: string };

/** The running state a clean-up shows: "Removing… N so far" and Cancel. */
export interface CleanupRunner {
  running: boolean;
  /** Events and calendars removed by the calls so far. */
  soFar: number;
  cancel: () => void;
}

/**
 * Runs a clean-up call again by itself while each answer made progress (see `runCleanup`). Cancel,
 * and leaving the page, stop it after the call in flight.
 */
export function useCleanupRunner() {
  const alive = useRef(true);
  const cancelled = useRef(false);
  const [running, setRunning] = useState(false);
  const [soFar, setSoFar] = useState(0);

  useEffect(() => {
    alive.current = true;
    return () => {
      alive.current = false;
    };
  }, []);

  const run = useCallback(async <T>(step: () => Promise<T>): Promise<CleanupRun<T>> => {
    cancelled.current = false;
    setSoFar(0);
    setRunning(true);
    try {
      return await runCleanup(step, {
        shouldContinue: () => alive.current && !cancelled.current,
        onProgress: (total) => {
          if (alive.current) {
            setSoFar(total.events + total.calendars);
          }
        },
      });
    } finally {
      if (alive.current) {
        setRunning(false);
      }
    }
  }, []);

  const cancel = useCallback(() => {
    cancelled.current = true;
  }, []);

  const runner: CleanupRunner = { running, soFar, cancel };
  return { run, runner };
}

/**
 * Runs the removal of the events pushed with one Google Calendar connection. Out of time is not a
 * failure: it goes on by itself while it makes progress; when stopped, the outcome carries the
 * progress and `run` again continues.
 */
export function useRemovePushed(workspaceId: string) {
  const { t } = useTranslation();
  const remove = useRemovePushedEvents(workspaceId);
  const cleanup = useCleanupRunner();
  const [outcome, setOutcome] = useState<CleanupOutcome | null>(null);

  const run = async (integrationId: string): Promise<CleanupOutcome> => {
    const result = await cleanup.run(() => remove.mutateAsync(integrationId));
    let next: CleanupOutcome;
    if (result.kind === 'done') {
      next = {
        kind: 'done',
        events: result.totals.events + result.value.events,
        skipped: Math.max(result.totals.skipped, result.value.skipped),
        failed: result.totals.failed + result.value.failed,
      };
    } else if (result.kind === 'incomplete') {
      next = { kind: 'incomplete', progress: result.progress };
    } else {
      next = { kind: 'error', message: errorMessage(t, result.failure, 'connect.pushed.error') };
    }
    setOutcome(next);
    return next;
  };

  return { outcome, run, pending: cleanup.runner.running, runner: cleanup.runner };
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
