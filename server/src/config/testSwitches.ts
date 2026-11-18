/**
 * Test-only switches. Nothing in a deployed stage is controlled by an environment variable: the
 * behaviours tests need to change are changed here, by code, and only under node:test (the runner
 * sets NODE_TEST_CONTEXT in every test process). Every other *ForTests setter in the server uses
 * assertUnderTest too, so none of them can run in a server (Lambda or src/local.ts).
 *
 * No imports of its own, so a test can import it statically before the environment is set up.
 */
import type { Transport } from '../sync/http.js';
import type { SyncMode } from '../types/env.d.ts';

/** Throws unless this process runs under node:test: the guard of every *ForTests setter. */
export function assertUnderTest(name: string): void {
  if ((process.env['NODE_TEST_CONTEXT'] ?? '') === '') {
    throw new Error(`${name} runs only under node:test`);
  }
}

let forcedSyncMode: SyncMode | null = null;
let rateLimitsOff = false;
let loopbackAllowed = false;

/** Tests only: every non-OAuth sync replays recorded fixtures (`fixtures`) instead of calling out. */
export function forceSyncModeForTests(mode: SyncMode | null): void {
  assertUnderTest('forceSyncModeForTests');
  forcedSyncMode = mode;
}

/** The mode a test forced, or null (always null on a deployed stage). */
export function forcedSyncModeForTests(): SyncMode | null {
  return forcedSyncMode;
}

/** Tests only: switches the in-app rate limits off (or back on). */
export function setRateLimitsOffForTests(off: boolean): void {
  assertUnderTest('setRateLimitsOffForTests');
  rateLimitsOff = off;
}

export function rateLimitsOffForTests(): boolean {
  return rateLimitsOff;
}

/**
 * Tests only: outbound calls may go to loopback hosts too (http or https), for the in-process
 * stand-ins of providers and Google (testing/mockGoogle.ts, mockOAuthProviders.ts). A server
 * always calls public https hosts only (services/netGuard.ts).
 */
export function setLoopbackAllowedForTests(allowed: boolean): void {
  assertUnderTest('setLoopbackAllowedForTests');
  loopbackAllowed = allowed;
}

/** False on every server; true only while a test allows loopback hosts. */
export function loopbackAllowedForTests(): boolean {
  return loopbackAllowed;
}

let travelTransport: Transport | null = null;

/** Tests only: the travel providers (OpenRouteService, Nominatim) answer through this transport. */
export function setTravelTransportForTests(transport: Transport | null): void {
  assertUnderTest('setTravelTransportForTests');
  travelTransport = transport;
}

/** The transport a test set, or null (always null on a deployed stage). */
export function travelTransportForTests(): Transport | null {
  return travelTransport;
}
