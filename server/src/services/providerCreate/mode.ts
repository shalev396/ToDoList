/**
 * May this integration be written to on this server? Always the real provider (an explicit and
 * audited user action), except for demo data and in the fixtures sync mode (tests only): never,
 * the credentials are not real. While a test points the providers at its in-process stand-in, the
 * transport (services/oauth/transport.ts) sends an OAuth integration's writes there.
 */
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { syncModeFor } from '../../sync/syncMode.js';

export type WriteMode = 'live' | 'off';

export function writeModeFor(
  integration: Pick<IntegrationData, 'provider' | 'authMethod'> &
    Partial<Pick<IntegrationData, 'demo'>>,
): WriteMode {
  if (integration.demo === true) return 'off';
  if (integration.provider === 'google_calendar') return 'live';
  if (syncModeFor(integration) === 'fixtures') return 'off';
  return 'live';
}
