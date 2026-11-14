import type { SyncRunView } from '@api-types/integrations.ts';

const DAY_MS = 24 * 60 * 60 * 1000;
/** The renewal hint shows this many days before `expiresAt` (the server's `expiring` window). */
export const RENEWAL_HINT_DAYS = 14;

/** Whole days left until `expiresAt`, rounded up; null when there is no expiry. */
export function daysUntil(expiresAt: string | Date | null, now: Date): number | null {
  if (expiresAt === null) {
    return null;
  }
  return Math.ceil((new Date(expiresAt).getTime() - now.getTime()) / DAY_MS);
}

/** True within 14 days of the expiry (and after it): the card suggests renewing. */
export function needsRenewalHint(expiresAt: string | Date | null, now: Date): boolean {
  const days = daysUntil(expiresAt, now);
  return days !== null && days <= RENEWAL_HINT_DAYS;
}

/** A run that is still going: poll while one is. */
export function isRunActive(run: Pick<SyncRunView, 'status'>): boolean {
  return run.status === 'queued' || run.status === 'running';
}

export function anyRunActive(runs: readonly Pick<SyncRunView, 'status'>[] | undefined): boolean {
  return runs?.some(isRunActive) ?? false;
}

/** The newest run of one integration (the list is newest first). */
export function latestRun<R extends Pick<SyncRunView, 'integrationId'>>(
  runs: readonly R[] | undefined,
  integrationId: string,
): R | undefined {
  return runs?.find((run) => run.integrationId === integrationId);
}

/** Polling interval while a run is active, else off. */
export const SYNC_POLL_MS = 3000;
export function syncPollInterval(runs: readonly Pick<SyncRunView, 'status'>[] | undefined) {
  return anyRunActive(runs) ? SYNC_POLL_MS : false;
}
