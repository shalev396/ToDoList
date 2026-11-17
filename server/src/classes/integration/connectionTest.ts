/**
 * The pieces of "test connection" (Integration#testConnection) that touch neither the database nor
 * a secret: the test's transport and deadline, what may be kept of an adapter's answer, and how a
 * failure maps to its fixed code.
 *
 * A test is short (R1): one try per provider request (`maxRetries: 0`, no waits) and 10 s for the
 * whole test. Failures answer `{ok: false, code}` with a fixed code, never provider text; the log
 * has ids, the code and an HTTP status or error name, never a message.
 */
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { INTEGRATION_LABEL_MAX, isPlaceholderAccountId } from '../../services/integrationConfig.js';
import { logger } from '../../services/logger.js';
import { findSecrets } from '../../services/secretPatterns.js';
import { FixtureMissingError, ProviderHttpError } from '../../sync/errors.js';
import type { Clock, HttpRequest, HttpResponse, Transport } from '../../sync/http.js';
import { liveTransport } from '../../sync/transports/live.js';
import type { ProviderAdapter } from '../../sync/types.js';
import type { IntegrationTestCode } from '../../types/integrations.js';

/** The whole test, decryption and every provider request included: it fits in an API request. */
export const CONNECTION_TEST_TIMEOUT_MS = 10_000;
const ACCOUNT_ID_MAX = 200;
const CAPABILITY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_CAPABILITIES = 20;

/**
 * A test makes a few requests at most, each tried once (no backoff or Retry-After to wait for), so
 * the client's request spacing, meant for long listings, takes no time either.
 */
export const NO_WAIT: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };

const realLiveTransport = (timeoutMs: number): Transport => liveTransport({ timeoutMs });
let liveTransportFor: (timeoutMs: number) => Transport = realLiveTransport;

/** The live network a connection test goes out on (or what a test put in its place). */
export function connectionTestTransport(): Transport {
  return liveTransportFor(CONNECTION_TEST_TIMEOUT_MS);
}

/**
 * Tests only: what stands in for the live network, under the connection test's own guards (one
 * try, the deadline); null restores it. It throws outside node:test, so production code can never
 * redirect a test's requests.
 */
export function setLiveTransportForTests(factory: ((timeoutMs: number) => Transport) | null): void {
  if ((process.env['NODE_TEST_CONTEXT'] ?? '') === '') {
    throw new Error('setLiveTransportForTests runs only under node:test');
  }
  liveTransportFor = factory ?? realLiveTransport;
}

export type TestableAdapter = ProviderAdapter & Required<Pick<ProviderAdapter, 'test'>>;

export function canTest(adapter: ProviderAdapter): adapter is TestableAdapter {
  return adapter.test !== undefined;
}

/** What may be kept of an adapter's answer: text that is not secret-shaped, boolean capabilities. */
export interface Probe {
  accountLabel: string;
  /** The real account key when the adapter names one; else the label stands in for it. */
  accountId: string | null;
  capabilities: Record<string, boolean> | null;
}

export type Outcome = { probe: Probe } | { code: IntegrationTestCode; error?: unknown };

/** "Test again later": the integration was tested LIMITS.connectionTestsPerMinute times. */
export interface TestRateLimited {
  retryAfterMs: number;
}

/** The adapter answered without a usable account label (none, too long, secret-shaped). */
class UnusableAnswer extends Error {
  constructor() {
    super('The connection test answered without a usable account label');
    this.name = 'UnusableAnswer';
  }
}

/** The test's time is up. */
class TestTimedOut extends Error {
  constructor() {
    super('The connection test ran out of time');
    this.name = 'TestTimedOut';
  }
}

/** `work`, or TestTimedOut once `deadline` (epoch ms) passes. The timer never outlives the race. */
export function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<never>((_resolve, reject) => {
    timer = setTimeout(
      () => {
        reject(new TestTimedOut());
      },
      Math.max(0, deadline - Date.now()),
    );
  });
  return Promise.race([work, late]).finally(() => {
    clearTimeout(timer);
  });
}

/**
 * The test's transport (R1). `maxRetries: 0` caps the client the adapter builds over it
 * (createReadOnlyClient takes the lower of its own setting and the transport's), so every request
 * is sent once and a failure is the provider's own code at once. Every request shares the test's
 * deadline.
 */
export function testTransport(inner: Transport, deadline: number): Transport {
  return {
    maxRetries: 0,
    send(request: HttpRequest): Promise<HttpResponse> {
      if (Date.now() >= deadline) return Promise.reject(new TestTimedOut());
      // A transport that throws instead of rejecting is turned into a rejection.
      return beforeDeadline(
        Promise.resolve().then(() => inner.send(request)),
        deadline,
      );
    },
  };
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > max || findSecrets(text).length > 0) return null;
  return text;
}

/** The adapter's answer is provider data: only the label, an account key and booleans pass. */
export function toProbe(answer: unknown): Probe {
  if (typeof answer !== 'object' || answer === null) throw new UnusableAnswer();
  const fields = answer as Record<string, unknown>;
  const accountLabel = cleanText(fields['accountLabel'], INTEGRATION_LABEL_MAX);
  if (accountLabel === null) throw new UnusableAnswer();
  const capabilities: Record<string, boolean> = {};
  const raw = fields['capabilities'];
  if (typeof raw === 'object' && raw !== null && !Array.isArray(raw)) {
    for (const [key, value] of Object.entries(raw).slice(0, MAX_CAPABILITIES)) {
      if (CAPABILITY_KEY.test(key) && typeof value === 'boolean') capabilities[key] = value;
    }
  }
  return {
    accountLabel,
    // The provider's stable account id, when the adapter reports one (ConnectionTestResult).
    accountId: cleanText(fields['accountId'], ACCOUNT_ID_MAX),
    capabilities: Object.keys(capabilities).length > 0 ? capabilities : null,
  };
}

/**
 * The label a test learns for a site provider (Jira, Moodle): the person's own name beside the
 * site, since one person on two sites would otherwise give two identical labels (many-to-one).
 */
export function labelWithSite(accountLabel: string, host: string): string {
  if (isPlaceholderAccountId(host) || accountLabel.includes(host)) return accountLabel;
  const joined = `${accountLabel} (${host})`;
  return joined.length <= INTEGRATION_LABEL_MAX ? joined : accountLabel;
}

export function failed(error: unknown): Outcome {
  if (error instanceof UnusableAnswer) return { code: 'bad_response', error };
  if (error instanceof ProviderHttpError) return { code: error.code, error };
  if (error instanceof FixtureMissingError) return { code: 'fixtures_missing', error };
  if (error instanceof TestTimedOut) return { code: 'network', error };
  return { code: 'internal', error };
}

/**
 * A test that failed on an error (the provider, the adapter, the vault). Ids, the code and a
 * status or an error name: never a message, which could quote the provider. The expected states
 * (no adapter, no test, no credential) answer their code without a log line.
 */
export function logFailure(
  integration: Pick<IntegrationData, 'id' | 'provider'>,
  code: IntegrationTestCode,
  error: unknown,
): void {
  if (error === undefined) return;
  const meta: Record<string, unknown> = {
    integrationId: integration.id,
    provider: integration.provider,
    code,
  };
  if (error instanceof ProviderHttpError) meta['status'] = error.status;
  else meta['errorName'] = error instanceof Error ? error.name : typeof error;
  if (code === 'internal') logger.error('connection test failed', meta);
  else logger.warn('connection test failed', meta);
}
