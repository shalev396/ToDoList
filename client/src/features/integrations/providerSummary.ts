import type { ProviderCapabilities, SyncRunView } from '@api-types/integrations.ts';
import { daysUntil, isRunActive, needsRenewalHint } from './status.ts';

/** What the summary reads of a connection (a slice of the status view; no server route types). */
export interface AccountState {
  id: string;
  accountLabel: string;
  status: string;
  needsReconnect: boolean;
  expiresAt: string | Date | null;
}

/** What a provider's card says about all its accounts together, worst first. */
export type ProviderHealth = 'error' | 'attention' | 'needs_reconnect' | 'syncing' | 'ok';

export interface ProviderSummary {
  /** How many accounts of this provider are connected. */
  count: number;
  /** Undefined without an account. */
  health: ProviderHealth | undefined;
  /** The only account's label when there is exactly one, else null. */
  label: string | null;
}

/** What the latest sync run of a connection says, by connection id. */
export interface RunFacts {
  syncing: (integrationId: string) => boolean;
  failed: (integrationId: string) => boolean;
}

/**
 * The provider card's one line: the number of accounts and the worst state among them. Worst
 * first: expired, in error or past its expiry (error); then one that expires within 14 days or
 * whose latest sync failed (attention); then one that must reconnect to finish switching to
 * read & write; then one whose latest sync run is still going.
 */
export function summarizeProvider(
  integrations: readonly AccountState[],
  runs: RunFacts,
  now: Date,
): ProviderSummary {
  if (integrations.length === 0) {
    return { count: 0, health: undefined, label: null };
  }
  const lapsed = (entry: AccountState): boolean => {
    const days = daysUntil(entry.expiresAt, now);
    return entry.status !== 'connected' || (days !== null && days <= 0);
  };
  let health: ProviderHealth = 'ok';
  if (integrations.some(lapsed)) {
    health = 'error';
  } else if (
    integrations.some((entry) => needsRenewalHint(entry.expiresAt, now) || runs.failed(entry.id))
  ) {
    health = 'attention';
  } else if (integrations.some((entry) => entry.needsReconnect)) {
    health = 'needs_reconnect';
  } else if (integrations.some((entry) => runs.syncing(entry.id))) {
    health = 'syncing';
  }
  return {
    count: integrations.length,
    health,
    label: integrations.length === 1 ? (integrations[0]?.accountLabel ?? null) : null,
  };
}

/** True when a connection's latest sync run failed or only partly worked. */
export function isFailed(run: Pick<SyncRunView, 'status'> | undefined): boolean {
  return run !== undefined && (run.status === 'failed' || run.status === 'partial');
}

/** True while a sync run of this connection is queued or running. */
export function isSyncing(run: Parameters<typeof isRunActive>[0] | undefined): boolean {
  return run !== undefined && isRunActive(run);
}

/**
 * After the owner switched a connection to read & write and it saved: whether to offer
 * "Reconnect now". The saved connection says so (`needsReconnect`, read from its grant). Only when
 * that answer is missing does it fall back to what the provider needs: an OAuth connection whose
 * provider asks for a write scope. A key or token never reconnects.
 */
export function shouldOfferReconnect(
  saved: { authMethod: string; needsReconnect?: boolean | undefined } | undefined,
  capabilities: Pick<ProviderCapabilities, 'needsWriteScope'> | undefined,
): boolean {
  if (saved?.authMethod !== 'oauth') {
    return false;
  }
  return saved.needsReconnect ?? capabilities?.needsWriteScope === true;
}
