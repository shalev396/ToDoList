import { useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { errorMessage } from '@/api/errors';
import { useCreateCopy } from '@/api/queries/providerCreate';
import { startProviderOAuth } from '@/api/services/integrationService';
import { useLanguage } from '@/hooks/useLanguage';
import { isDone, toTarget, type FunnelState } from './funnel';
import { nextAttempt, type Phase } from './retry';
import { writeRemembered } from './remembered';

/** One target's row in the results. */
export interface Result {
  integrationId: string;
  provider: string;
  requestId: string;
  phase: Phase;
  funnel: FunnelState;
  /** "Retry anyway" was asked and the warning is showing. */
  confirming: boolean;
}

const newId = (): string => crypto.randomUUID().replaceAll('-', '').slice(0, 32);
export const newRequestId = newId;

/** Where the user returns to after consenting: the to-do and the target to preselect. */
const RETURN_KEY = 'todolist-create-return';

export interface ConsentReturn {
  todoId: string;
  integrationId: string;
  path: string;
  /** Select that integration in the to-do's "Also create in" (false: the item's own sign-in). */
  preselect?: boolean;
}

export function rememberConsentReturn(value: ConsentReturn): void {
  try {
    sessionStorage.setItem(RETURN_KEY, JSON.stringify(value));
  } catch {
    /* a convenience */
  }
}

export function takeConsentReturn(): ConsentReturn | null {
  try {
    const raw = sessionStorage.getItem(RETURN_KEY);
    if (raw === null) {
      return null;
    }
    sessionStorage.removeItem(RETURN_KEY);
    const parsed = JSON.parse(raw) as Partial<ConsentReturn>;
    return typeof parsed.todoId === 'string' &&
      typeof parsed.integrationId === 'string' &&
      typeof parsed.path === 'string'
      ? {
          todoId: parsed.todoId,
          integrationId: parsed.integrationId,
          path: parsed.path,
          preselect: parsed.preselect !== false,
        }
      : null;
  } catch {
    return null;
  }
}

/**
 * Runs the copies of one to-do and keeps their results: every target at once, Retry by the rules of
 * retry.ts (the same request id after a failed request), the consent round trip.
 */
export function useCopyRunner(workspaceId: string, userId: string, todoId: () => string | null) {
  const { t } = useTranslation();
  const { language } = useLanguage();
  const createCopy = useCreateCopy(workspaceId);
  const [results, setResults] = useState<Result[] | null>(null);
  const live = useRef<Result[]>([]);

  const patch = (integrationId: string, change: (result: Result) => Result) => {
    live.current = live.current.map((result) =>
      result.integrationId === integrationId ? change(result) : result,
    );
    setResults(live.current);
  };

  const send = async (result: Result, requestId: string, retryAnyway: boolean) => {
    const target = toTarget(result.funnel);
    const id = todoId();
    if (id === null || target === null) {
      return;
    }
    patch(result.integrationId, (current) => ({
      ...current,
      requestId,
      confirming: false,
      phase: { kind: 'pending' },
    }));
    try {
      const outcome = await createCopy.mutateAsync({
        itemId: id,
        body: {
          requestId,
          integrationId: result.integrationId,
          target,
          ...(retryAnyway ? { retryAnyway: true } : {}),
        },
      });
      if (outcome.status === 'created') {
        writeRemembered(userId, result.funnel);
      }
      patch(result.integrationId, (current) => ({
        ...current,
        phase: { kind: 'outcome', outcome },
      }));
    } catch (failure) {
      patch(result.integrationId, (current) => ({
        ...current,
        phase: {
          kind: 'error',
          message: errorMessage(t, failure, 'items.newTodo.results.rejected'),
        },
      }));
    }
  };

  /** `retryAnyway`: the integrations where the user confirmed creating again over a copy that may exist. */
  const run = async (
    funnels: readonly FunnelState[],
    retryAnyway: ReadonlySet<string> = new Set(),
  ) => {
    const ready = funnels.filter((funnel) => isDone(funnel));
    live.current = ready.map((funnel) => ({
      integrationId: funnel.integrationId,
      provider: funnel.provider,
      requestId: newId(),
      phase: { kind: 'pending' },
      funnel,
      confirming: false,
    }));
    setResults(live.current);
    // Every target at once: a slow provider never holds up the others.
    await Promise.all(
      live.current.map((result) =>
        send(result, result.requestId, retryAnyway.has(result.integrationId)),
      ),
    );
  };

  const retry = (integrationId: string) => {
    const result = live.current.find((entry) => entry.integrationId === integrationId);
    if (result === undefined) {
      return;
    }
    const next = nextAttempt(result.phase, result.requestId, newId);
    if (next.warn && !result.confirming) {
      patch(integrationId, (current) => ({ ...current, confirming: true }));
      return;
    }
    void send(result, next.requestId, next.retryAnyway);
  };

  const allow = async (integrationId: string) => {
    const result = live.current.find((entry) => entry.integrationId === integrationId);
    const id = todoId();
    if (result === undefined || (result.provider !== 'jira' && result.provider !== 'linear')) {
      return;
    }
    try {
      if (id !== null) {
        rememberConsentReturn({
          todoId: id,
          integrationId,
          path: `${window.location.pathname}${window.location.search}`,
        });
      }
      const { data } = await startProviderOAuth(
        workspaceId,
        result.provider,
        { lng: language, integrationId, includeWrite: true },
        { suppressErrorToast: true },
      );
      window.location.assign(data.authorizeUrl);
    } catch (failure) {
      patch(integrationId, (current) => ({
        ...current,
        phase: { kind: 'error', message: errorMessage(t, failure, 'connect.oauth.startFailed') },
      }));
    }
  };

  const reset = () => {
    live.current = [];
    setResults(null);
  };

  return { results, run, retry, allow, reset };
}
