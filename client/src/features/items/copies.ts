import type { ItemStatus, Provider } from '@api-types/domain.ts';

/** One provider copy of a local to-do (H5), as a row or the sheet shows it. */
export interface CopyChip {
  provider: Provider;
  key: string | null;
  url: string;
  /** pending | created | failed | unknown */
  status: string;
  /** When the copy was started (a pending one older than 2 minutes reads as unknown). */
  at?: Date | string | null | undefined;
  integrationId?: string | undefined;
  /** The provider's own status of the copy once it is synced. */
  liveStatus?: ItemStatus | null | undefined;
}

const STATUSES: ReadonlySet<string> = new Set(['pending', 'created', 'failed', 'unknown']);

/** A copy still pending after this long is unknown (the request that made it is gone). */
const PENDING_MAX_MS = 2 * 60 * 1000;

export function effectiveStatus(status: string, at: unknown, now: number = Date.now()): string {
  if (status !== 'pending') {
    return status;
  }
  const started = typeof at === 'string' || at instanceof Date ? new Date(at).getTime() : NaN;
  return Number.isFinite(started) && now - started > PENDING_MAX_MS ? 'unknown' : status;
}

/** The chips a list row carries: `props.copies`, written by the server whenever the copies change. */
export function copiesOfProps(props: Readonly<Record<string, unknown>>): CopyChip[] {
  const raw = props['copies'];
  if (!Array.isArray(raw)) {
    return [];
  }
  return (raw as unknown[]).flatMap((entry) => {
    if (typeof entry !== 'object' || entry === null) {
      return [];
    }
    const { provider, key, url, status } = entry as Record<string, unknown>;
    if (typeof provider !== 'string' || typeof status !== 'string' || !STATUSES.has(status)) {
      return [];
    }
    return [
      {
        provider: provider as Provider,
        key: typeof key === 'string' ? key : null,
        url: typeof url === 'string' ? url : '',
        status: effectiveStatus(status, (entry as { at?: unknown }).at),
      },
    ];
  });
}
