/**
 * The HTTP client of the travel providers: read-only, through the live transport (SSRF guard
 * included), or a test's transport. Nominatim's usage policy allows one request a second, so its
 * client spaces calls 1.1 s apart: that spacing lives in one client, so the process shares one
 * (`sharedNominatimClient`). Errors carry the provider's name and a status, never a URL.
 *
 * The OpenRouteService key is optional: read from the stage's app secret when asked, and null
 * when it isn't set (or can't be read), so travel falls back to the providers that need none.
 */
import { travelTransportForTests } from '../../config/testSwitches.js';
import { AppSecretError, getAppSecret } from '../../services/appSecrets.js';
import { logger } from '../../services/logger.js';
import {
  createReadOnlyClient,
  type Clock,
  type ReadOnlyClient,
  type Transport,
} from '../../sync/http.js';
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

let nominatim: { client: ReadOnlyClient; transport: Transport | null } | null = null;

/**
 * The process's one Nominatim client, so every geocode of the process keeps the 1.1 s spacing. A
 * test that sets another transport gets a client of its own (never on a deployed stage).
 */
export function sharedNominatimClient(): ReadOnlyClient {
  const transport = travelTransportForTests();
  if (nominatim?.transport !== transport) {
    nominatim = { client: travelClient('nominatim'), transport };
  }
  return nominatim.client;
}

/**
 * The OpenRouteService key, or null when the stage has none: travel then uses the remembered
 * length, the straight line and Nominatim. A secret that can't be read is logged (its reason, never
 * a value) and treated the same, so travel keeps working.
 */
export async function openRouteServiceKey(): Promise<string | null> {
  try {
    const { apiKey } = await getAppSecret<{ apiKey: string }>('openrouteservice');
    return apiKey;
  } catch (error) {
    if (!(error instanceof AppSecretError)) throw error;
    if (error.reason !== 'missing') {
      logger.warn('The OpenRouteService key could not be read', { reason: error.reason });
    }
    return null;
  }
}
