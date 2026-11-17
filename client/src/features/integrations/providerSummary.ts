import type { ProviderCapabilities } from '@api-types/integrations.ts';
import { isRunActive } from './status.ts';

/** What the summary reads of a connection (a slice of the status view; no server route types). */
export interface AccountState {
  id: string;
  accountLabel: string;
  status: string;
  needsReconnect: boolean;
}

/** What a provider's card says about all its accounts together, worst first. */
export type ProviderHealth = 'error' | 'needs_reconnect' | 'syncing' | 'ok';

export interface ProviderSummary {
  /** How many accounts of this provider are connected. */
  count: number;
  /** Undefined without an account. */
  health: ProviderHealth | undefined;
  /** The only account's label when there is exactly one, else null. */
  label: string | null;
}

/**
 * The provider card's one line: the number of accounts and the worst state among them. A
 * connection that is expired or in error is worst, then one that must reconnect to finish
 * switching to read & write, then one whose latest sync run is still going.
 */
export function summarizeProvider(
  integrations: readonly AccountState[],
  syncing: (integrationId: string) => boolean,
): ProviderSummary {
  if (integrations.length === 0) {
    return { count: 0, health: undefined, label: null };
  }
  let health: ProviderHealth = 'ok';
  if (integrations.some((entry) => entry.status !== 'connected')) {
    health = 'error';
  } else if (integrations.some((entry) => entry.needsReconnect)) {
    health = 'needs_reconnect';
  } else if (integrations.some((entry) => syncing(entry.id))) {
    health = 'syncing';
  }
  return {
    count: integrations.length,
    health,
    label: integrations.length === 1 ? (integrations[0]?.accountLabel ?? null) : null,
  };
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
