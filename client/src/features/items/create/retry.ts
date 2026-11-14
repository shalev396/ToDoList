/**
 * What a Retry sends (H5): the one rule that keeps a retry from creating twice.
 * - After an `error` (the request itself failed: a timeout, a dropped answer) the provider may
 *   already have created the item, so Retry resends the SAME request id: the server answers with
 *   what it recorded.
 * - After an explicit `failed` outcome nothing was created: a new id.
 * - After `unknown` ("may exist") only the user can decide: a new id, `retryAnyway`, and a
 *   warning first.
 */
import type { CreateCopyOutcome } from '@api-types/providerCreate.ts';

export type Phase =
  | { kind: 'pending' }
  | { kind: 'outcome'; outcome: CreateCopyOutcome }
  | { kind: 'error'; message: string };

export interface NextAttempt {
  requestId: string;
  retryAnyway: boolean;
  /** Show "this may create a second copy" and ask first. */
  warn: boolean;
}

export function nextAttempt(phase: Phase, current: string, makeId: () => string): NextAttempt {
  if (phase.kind === 'outcome' && phase.outcome.status === 'unknown') {
    return { requestId: makeId(), retryAnyway: true, warn: true };
  }
  if (phase.kind === 'outcome' && phase.outcome.status !== 'created') {
    return { requestId: makeId(), retryAnyway: false, warn: false };
  }
  return { requestId: current, retryAnyway: false, warn: false };
}

/**
 * The integrations a Create press may send `retryAnyway` for: only the one the user chose to
 * retry, and only once they confirmed the warning. Never every selected target.
 */
export function retryAnywayIds(
  focus: { integrationId: string; anyway: boolean } | null,
  confirmed: boolean,
): ReadonlySet<string> {
  return focus?.anyway === true && confirmed ? new Set([focus.integrationId]) : new Set();
}

/** The press must first show the warning (retry anyway chosen, selected, not yet confirmed). */
export function needsRetryWarning(
  focus: { integrationId: string; anyway: boolean } | null,
  selectedIds: readonly string[],
  confirmed: boolean,
): boolean {
  return focus?.anyway === true && selectedIds.includes(focus.integrationId) && !confirmed;
}
