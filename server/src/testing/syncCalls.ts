/**
 * The sync's old entry points, one line each over the classes, for the suites written against
 * them (the call shapes and the assertions stay the same): `runIntegrationSync` is
 * Integration.runSync (the template method Integration#sync and its engine), and `enqueueSync`
 * queues a background run through SyncRun.request, as the dispatcher does (no caller).
 *
 * Import it dynamically, after the test database is up, like the modules it stands for.
 */
import { Integration } from '../classes/integration/index.js';
import type { SyncRunOptions } from '../classes/sync/SyncEngine.js';
import { SyncRun } from '../classes/sync/SyncRun.js';
import type { SyncTrigger } from '../types/domain.js';
import type { SyncRunSummary } from '../sync/types.js';

export type { SyncRunOptions } from '../classes/sync/SyncEngine.js';

export function runIntegrationSync(
  integrationId: string,
  options: SyncRunOptions,
): Promise<SyncRunSummary> {
  return Integration.runSync(integrationId, options);
}

/** A queued run of the integration by id (global), its job started; throws when it is missing. */
export async function enqueueSync(
  integrationId: string,
  trigger: SyncTrigger,
): Promise<{ runId: string }> {
  const integration = await Integration.forWorker(integrationId);
  if (integration === null) throw new Error('enqueueSync: integration not found');
  return { runId: (await SyncRun.request(null, integration, trigger)).id };
}
