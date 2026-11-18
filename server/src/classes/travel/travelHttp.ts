/**
 * The HTTP client of the travel providers: read-only, through the live transport (SSRF guard
 * included), or a test's transport. Nominatim's usage policy allows one request a second, so its
 * client spaces calls 1.1 s apart. Errors carry the provider's name and a status, never a URL.
 */
import { travelTransportForTests } from '../../config/testSwitches.js';
import { createReadOnlyClient, type Clock, type ReadOnlyClient } from '../../sync/http.js';
import { liveTransport } from '../../sync/transports/live.js';

export const NOMINATIM_MIN_INTERVAL_MS = 1100;

export function travelClient(
  provider: 'openrouteservice' | 'nominatim',
  clock?: Clock,
): ReadOnlyClient {
  return createReadOnlyClient({
    provider,
    transport: travelTransportForTests() ?? liveTransport(),
    ...(clock === undefined ? {} : { clock }),
    ...(provider === 'nominatim' ? { minIntervalMs: NOMINATIM_MIN_INTERVAL_MS } : {}),
  });
}
