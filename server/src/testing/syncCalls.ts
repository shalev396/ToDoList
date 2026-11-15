/**
 * The sync's old entry points, one line each over the classes, for the suites written against
 * them (the call shapes and the assertions stay the same): `runIntegrationSync` is
 * Integration.runSync (the template method Integration#sync and its engine), and `enqueueSync`
 * is Integration.requestRun, as the dispatcher calls it (no caller).
 *
 * Import it dynamically, after the test database is up, like the modules it stands for.
 */
import { Integration } from '../classes/integration/index.js';
import type { SyncRunOptions } from '../classes/sync/index.js';
import type { SyncTrigger } from '../types/domain.js';
import type { SyncRunSummary } from '../sync/types.js';

export type { SyncRunOptions } from '../classes/sync/index.js';

export function runIntegrationSync(
  integrationId: string,
  options: SyncRunOptions,
): Promise<SyncRunSummary> {
  return Integration.runSync(integrationId, options);
}

/** Integration.requestRun for the system (the dispatcher's call), answered in the old shape. */
export async function enqueueSync(
  integrationId: string,
  trigger: SyncTrigger,
): Promise<{ runId: string }> {
  return { runId: (await Integration.requestRun(integrationId, trigger)).id };
}
