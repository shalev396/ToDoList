/**
 * The transport of every OAuth app call of GitHub, Jira, ClickUp and Linear (token, refresh,
 * revoke, identity): live unless a test swaps it. Where a session of an OAuth integration goes out
 * while a test points the providers at its stand-in is the strategy's (OAuthAuth#transport).
 */
import { assertUnderTest } from '../../config/testSwitches.js';
import type { Transport } from '../../sync/http.js';
import { liveTransport } from '../../sync/transports/live.js';

let factory: () => Transport = () => liveTransport();

/** The transport of every OAuth call (token, refresh, revoke, identity): live unless a test swaps it. */
export const oauthTransport = (): Transport => factory();

/** Tests only (node:test): replaces the transport; null restores the live one. */
export function setOAuthTransportForTests(next: (() => Transport) | null): void {
  assertUnderTest('setOAuthTransportForTests');
  factory = next ?? ((): Transport => liveTransport());
}
