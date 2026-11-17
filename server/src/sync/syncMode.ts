/**
 * The sync mode of one integration. A server always syncs live; the `fixtures` transport
 * (recorded provider answers) is a test utility: a test forces it with forceSyncModeForTests, or
 * passes `mode: 'fixtures'` to the engine directly. An OAuth connection syncs live: its grant is
 * the user's own, real one, and no recorded fixture stands in for it.
 */
import { forcedSyncModeForTests } from '../config/testSwitches.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import type { SyncMode } from '../types/env.d.ts';

export function syncModeFor(
  integration: Pick<IntegrationData, 'authMethod'> & Partial<Pick<IntegrationData, 'provider'>>,
  requested: SyncMode = 'live',
): SyncMode {
  if (integration.authMethod === 'oauth') return 'live';
  return forcedSyncModeForTests() ?? requested;
}
