import { assertUnderTest } from '../../config/testSwitches.js';
import { DestinationRefusedError, type HttpResponse, type Transport } from '../../sync/http.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import {
  OAUTH_ENDPOINTS,
  oauthEndpoints,
  oauthMockOrigin,
} from '../../sync/providers/oauthEndpoints.js';
import { isLoopbackHost } from '../netGuard.js';
import { isOAuthProviderId } from './providers.js';
import { liveTransport } from '../../sync/transports/live.js';

let factory: () => Transport = () => liveTransport();

/** The transport of every OAuth call (token, refresh, revoke, identity): live unless a test swaps it. */
export const oauthTransport = (): Transport => factory();

/** Tests only (node:test): replaces the transport; null restores the live one. */
export function setOAuthTransportForTests(next: (() => Transport) | null): void {
  assertUnderTest('setOAuthTransportForTests');
  factory = next ?? ((): Transport => liveTransport());
}

/**
 * The transport of a sync or a connection test of an OAuth integration of GitHub, Jira, ClickUp
 * or Linear. Unchanged in a server. While a test points the providers at its in-process stand-in
 * (setOAuthBaseUrlForTests), the provider's API base is rewritten to the stand-in and any request
 * left for a non-loopback host is refused. The adapters stay unaware.
 */
export function transportForIntegration(
  inner: Transport,
  integration: Pick<IntegrationData, 'provider' | 'authMethod'>,
): Transport {
  const { provider } = integration;
  if (integration.authMethod !== 'oauth' || !isOAuthProviderId(provider)) return inner;
  if (oauthMockOrigin() === null) return inner;
  const real = OAUTH_ENDPOINTS[provider].api;
  const mocked = oauthEndpoints(provider).api;
  return {
    ...(inner.maxRetries === undefined ? {} : { maxRetries: inner.maxRetries }),
    async send(request): Promise<HttpResponse> {
      const url =
        request.url === real || request.url.startsWith(`${real}/`)
          ? `${mocked}${request.url.slice(real.length)}`
          : request.url;
      let host = '';
      try {
        host = new URL(url).hostname;
      } catch {
        // Refused below.
      }
      if (!isLoopbackHost(host)) throw new DestinationRefusedError();
      return await inner.send({ ...request, url });
    },
  };
}
