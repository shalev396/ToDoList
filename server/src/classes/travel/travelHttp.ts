/**
 * The HTTP client of the travel providers: read-only, through the live transport (SSRF guard
 * included), or a test's transport. Nominatim's usage policy allows one request a second, so its
 * client spaces calls 1.1 s apart: that spacing lives in one client, so the process shares one
 * (`sharedNominatimClient`). Errors carry the provider's name and a status, never a URL.
 *
 * Travel runs inside a regeneration's few seconds (an item write waits for it), so its clients are
 * short: TRAVEL_HTTP_TIMEOUT_MS per attempt, no retry at OpenRouteService (the chain falls back
 * instead), one at Nominatim, and at most TRAVEL_RATE_LIMIT_WAIT_MS for a rate limit's reset.
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
import { Reachability } from './routing/Reachability.js';

export const NOMINATIM_MIN_INTERVAL_MS = 1100;
/** One attempt's longest wait for an answer. */
export const TRAVEL_HTTP_TIMEOUT_MS = 5_000;
/** The longest wait for a rate limit's reset: past it, the request fails. */
export const TRAVEL_RATE_LIMIT_WAIT_MS = 2_000;
/** Retries after a failed attempt, per provider. */
const RETRIES: Readonly<Record<'openrouteservice' | 'nominatim', number>> = {
  openrouteservice: 0,
  nominatim: 1,
};

export function travelClient(
  provider: 'openrouteservice' | 'nominatim',
  clock?: Clock,
): ReadOnlyClient {
  return createReadOnlyClient({
    provider,
    transport: travelTransportForTests() ?? liveTransport({ timeoutMs: TRAVEL_HTTP_TIMEOUT_MS }),
    maxRetries: RETRIES[provider],
    maxWaitMs: TRAVEL_RATE_LIMIT_WAIT_MS,
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

let routing: { reachability: Reachability; transport: Transport | null } | null = null;

/**
 * The process's one record of whether OpenRouteService answered lately (Reachability): an outage
 * found by one regeneration spares the next ones the wait. In memory only. A test that sets
 * another transport starts afresh (never on a deployed stage).
 */
export function sharedRoutingReachability(): Reachability {
  const transport = travelTransportForTests();
  if (routing?.transport !== transport) {
    routing = { reachability: new Reachability(), transport };
  }
  return routing.reachability;
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
