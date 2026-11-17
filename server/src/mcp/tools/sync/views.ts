/** What the sync tools show of a run: BACKEND.md's sanitized view, dates as ISO strings. */
import { z } from 'zod';

import { SYNC_RUN_STATUSES, SYNC_TRIGGERS } from '../../../types/domain.js';
import type { SyncRunView } from '../../../types/integrations.js';

export const RunId = z.string().min(1).max(100).describe('A run id, as sync_now gives it');
export const IntegrationId = z
  .string()
  .min(1)
  .max(100)
  .describe('An integration id, as integrations_list gives it');

export const RunView = z.object({
  id: z.string(),
  integrationId: z.string(),
  trigger: z.enum(SYNC_TRIGGERS),
  status: z.enum(SYNC_RUN_STATUSES),
  startedAt: z.string(),
  finishedAt: z.string().nullable(),
  counts: z
    .record(z.string(), z.number())
    .describe('e.g. fetched, inserted, updated, unchanged, deleted, failed'),
  error: z
    .object({ code: z.string(), message: z.string() })
    .nullable()
    .describe('A code and its fixed message; never what the provider said'),
});
export type RunView = z.output<typeof RunView>;

export function toRunView(run: SyncRunView): RunView {
  return {
    ...run,
    startedAt: run.startedAt.toISOString(),
    finishedAt: run.finishedAt?.toISOString() ?? null,
  };
}
