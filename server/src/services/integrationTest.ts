/**
 * "Test connection" (BACKEND.md §4, DATA.md §3.5): the provider adapter's `test(ctx)` (GET calls,
 * or allow-listed GraphQL reads) says which account the credential reaches. This module is on
 * the credential vault's import allow-list (vaultImports.test.ts):
 * - live mode: the secret exists only inside CredentialVault.decryptForSync's callback, which
 *   builds the adapter context over the live transport, runs the test and returns only a
 *   sanitized `{accountLabel, accountId, capabilities}`. The vault refuses a result that carries
 *   a secret value, and redacts what the callback throws.
 * - fixtures mode (tests only, testSwitches): the adapter's recorded fixture set and an empty secret.
 *   The vault is never called.
 *
 * A test is short (R1): one try per provider request (`maxRetries: 0`, no waits) and 10 s for the
 * whole test, and an integration is tested at most LIMITS.connectionTestsPerMinute times a minute
 * (`{retryAfterMs}` otherwise).
 *
 * Failures answer `{ok: false, code}` with a fixed code, never provider text; the log has ids,
 * the code and an HTTP status or error name, never a message. `auth_failed` puts the integration
 * in `error` (a reconnect) unless it is paused or expired. On success, a `pending:` account
 * becomes the real one (once) and a default label becomes the account's own.
 */
import { syncModeFor } from '../sync/syncMode.js';
import { LIMITS } from '../config/limits.js';
import { AppError } from '../errors/AppError.js';
import type { ConnectionTestPatch, IntegrationData } from '../models/definitions/Integration.js';
import {
  getAuditLogRepository,
  getCredentialRepository,
  getIntegrationRepository,
} from '../models/index.js';
import { FixtureMissingError, ProviderHttpError } from '../sync/errors.js';
import { fixtureSetDir } from '../sync/fixtureSets.js';
import type { Clock, HttpRequest, HttpResponse, Transport } from '../sync/http.js';
import '../sync/providers/index.js';
import { getAdapter } from '../sync/registry.js';
import { SYNC_ERROR_MESSAGES } from '../sync/runSync.js';
import { fixtureTransport, loadFixtureSet } from '../sync/transports/fixtures.js';
import { liveTransport } from '../sync/transports/live.js';
import type { AdapterContext, ProviderAdapter } from '../sync/types.js';
import type { IntegrationTestCode, IntegrationTestResult } from '../types/integrations.js';
import type { WorkspaceContext } from './accessFilter.js';
import { findOwnIntegration } from './integrationOwnership.js';
import { decryptForSync } from './crypto/credentialVault.js';
import { transportForIntegration } from './oauth/transport.js';
import {
  defaultLabel,
  INTEGRATION_LABEL_MAX,
  isConnectableProvider,
  isPlaceholderAccountId,
} from './integrationConfig.js';
import { auditIntegration, isDuplicateKey, type IntegrationActor } from './integrations.js';
import { logger } from './logger.js';
import { findSecrets } from './secretPatterns.js';

/** The whole test, decryption and every provider request included: it fits in an API request. */
export const CONNECTION_TEST_TIMEOUT_MS = 10_000;
const RATE_WINDOW_MS = 60_000;
/** Tests audited in one workspace in a minute: at most 5 per integration, 20 integrations. */
const RECENT_TESTS_SCANNED = 200;
const ACCOUNT_ID_MAX = 200;
const CAPABILITY_KEY = /^[A-Za-z][A-Za-z0-9_]{0,39}$/;
const MAX_CAPABILITIES = 20;

const NO_SECRET: Readonly<Record<string, string>> = Object.freeze({});

/**
 * A test makes a few requests at most, each tried once (no backoff or Retry-After to wait for), so
 * the client's request spacing, meant for long listings, takes no time either.
 */
const NO_WAIT: Clock = { now: () => Date.now(), sleep: () => Promise.resolve() };

const realLiveTransport = (timeoutMs: number): Transport => liveTransport({ timeoutMs });
let liveTransportFor: (timeoutMs: number) => Transport = realLiveTransport;

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

type TestableAdapter = ProviderAdapter & Required<Pick<ProviderAdapter, 'test'>>;

/** What may be kept of an adapter's answer: text that is not secret-shaped, boolean capabilities. */
interface Probe {
  accountLabel: string;
  /** The real account key when the adapter names one; else the label stands in for it. */
  accountId: string | null;
  capabilities: Record<string, boolean> | null;
}

type Outcome = { probe: Probe } | { code: IntegrationTestCode; error?: unknown };

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
function beforeDeadline<T>(work: Promise<T>, deadline: number): Promise<T> {
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
function testTransport(inner: Transport, deadline: number): Transport {
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

function canTest(adapter: ProviderAdapter): adapter is TestableAdapter {
  return adapter.test !== undefined;
}

function cleanText(value: unknown, max: number): string | null {
  if (typeof value !== 'string') return null;
  const text = value.trim();
  if (text === '' || text.length > max || findSecrets(text).length > 0) return null;
  return text;
}

/** The adapter's answer is provider data: only the label, an account key and booleans pass. */
function toProbe(answer: unknown): Probe {
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

/** The adapter's connection test over `transport`, with `secret` (`{}` in fixtures mode). */
async function probe(
  adapter: TestableAdapter,
  integration: IntegrationData,
  timeZone: string,
  secret: Readonly<Record<string, string>>,
  transport: Transport,
  deadline: number,
): Promise<Probe> {
  const ctx: AdapterContext = {
    integration,
    secret,
    client: adapter.createClient(testTransport(transport, deadline), NO_WAIT),
    now: new Date(),
    timeZone,
    fullSyncDue: false,
  };
  return toProbe(await beforeDeadline(adapter.test(ctx), deadline));
}

function failed(error: unknown): Outcome {
  if (error instanceof UnusableAnswer) return { code: 'bad_response', error };
  if (error instanceof ProviderHttpError) return { code: error.code, error };
  if (error instanceof FixtureMissingError) return { code: 'fixtures_missing', error };
  if (error instanceof TestTimedOut) return { code: 'network', error };
  return { code: 'internal', error };
}

async function runTest(ctx: WorkspaceContext, integration: IntegrationData): Promise<Outcome> {
  const adapter = getAdapter(integration.provider);
  if (adapter === null) return { code: 'no_adapter' };
  if (!canTest(adapter)) return { code: 'not_supported' };
  const timeZone = ctx.settings.timezone;
  const deadline = Date.now() + CONNECTION_TEST_TIMEOUT_MS;

  if (syncModeFor(integration) === 'fixtures') {
    let transport: Transport;
    try {
      transport = fixtureTransport(await loadFixtureSet(fixtureSetDir(adapter)));
    } catch (error) {
      return { code: 'fixtures_missing', error };
    }
    try {
      return { probe: await probe(adapter, integration, timeZone, NO_SECRET, transport, deadline) };
    } catch (error) {
      return failed(error);
    }
  }

  const credential = await (await getCredentialRepository()).findMeta(ctx.id, integration.id);
  if (credential === null) return { code: 'credential_missing' };
  // An object, so the callback's write is seen after the await (a flag would stay narrowed).
  const progress = { opened: false };
  try {
    const found = await decryptForSync(integration.id, (secret) => {
      progress.opened = true;
      const transport = transportForIntegration(
        liveTransportFor(CONNECTION_TEST_TIMEOUT_MS),
        integration,
      );
      return probe(adapter, integration, timeZone, secret, transport, deadline);
    });
    return { probe: found };
  } catch (error) {
    // Thrown before the callback ran: the vault could not produce the secret.
    // A refused OAuth refresh happens before the callback: it is the provider saying reconnect.
    if (progress.opened || (error instanceof ProviderHttpError && error.code === 'auth_failed')) {
      return failed(error);
    }
    return { code: 'credential_unavailable', error };
  }
}

/**
 * A test that failed on an error (the provider, the adapter, the vault). Ids, the code and a
 * status or an error name: never a message, which could quote the provider. The expected states
 * (no adapter, no test, no credential) answer their code without a log line.
 */
function logFailure(integration: IntegrationData, code: IntegrationTestCode, error: unknown): void {
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

/**
 * The label a test learns. A site provider (Jira, Moodle) keeps its site beside the person's own
 * name: one person on two sites would otherwise give two identical labels (many-to-one).
 */
function learnedLabel(integration: IntegrationData, accountLabel: string): string {
  if (integration.provider !== 'jira' && integration.provider !== 'moodle') return accountLabel;
  const host = integration.accountId;
  if (isPlaceholderAccountId(host) || accountLabel.includes(host)) return accountLabel;
  const joined = `${accountLabel} (${host})`;
  return joined.length <= INTEGRATION_LABEL_MAX ? joined : accountLabel;
}

/**
 * A pending account becomes the real one (once); a default label becomes the account's own; a
 * GitHub integration's `config.boards.enabled` follows what its token can read, so a token without
 * Projects access doesn't fail every sync on its boards (and a new one turns them back on). The
 * label and the boards setting are written field by field (recordConnectionTest), so a label or
 * config saved while the test ran is kept.
 */
async function recordSuccess(
  ctx: WorkspaceContext,
  integration: IntegrationData,
  found: Probe,
): Promise<IntegrationTestResult> {
  const integrations = await getIntegrationRepository();
  if (isPlaceholderAccountId(integration.accountId)) {
    try {
      await integrations.replacePendingAccount(
        ctx.id,
        integration.id,
        found.accountId ?? found.accountLabel,
      );
    } catch (error) {
      if (isDuplicateKey(error)) return { ok: false, code: 'already_connected' };
      throw error;
    }
  }
  const learned: ConnectionTestPatch = {};
  if (isConnectableProvider(integration.provider)) {
    const label = defaultLabel(integration.provider, integration.config);
    if (integration.label === label && found.accountLabel !== label) {
      learned.label = { from: label, to: learnedLabel(integration, found.accountLabel) };
    }
  }
  const boards = found.capabilities?.['boards'];
  if (integration.provider === 'github' && boards !== undefined) learned.boardsEnabled = boards;
  if (learned.label !== undefined || learned.boardsEnabled !== undefined) {
    await integrations.recordConnectionTest(ctx.id, integration.id, learned);
  }
  return {
    ok: true,
    accountLabel: found.accountLabel,
    ...(found.capabilities === null ? {} : { capabilities: found.capabilities }),
  };
}

/**
 * How long until the integration may be tested again (0: now). Every test that ran is audited
 * (`integration.test`), so the audit log counts them; a refused request isn't counted.
 */
async function waitBeforeNextTest(ctx: WorkspaceContext, integrationId: string): Promise<number> {
  const now = Date.now();
  const entries = await (
    await getAuditLogRepository()
  ).list(
    ctx.id,
    { action: 'integration.test', since: new Date(now - RATE_WINDOW_MS) },
    RECENT_TESTS_SCANNED,
  );
  // Newest first: the last one that still counts against the limit.
  const counted = entries.filter((entry) => entry.targetId === integrationId);
  const oldest = counted[LIMITS.connectionTestsPerMinute - 1];
  if (oldest === undefined) return 0;
  return Math.max(1, oldest.at.getTime() + RATE_WINDOW_MS - now);
}

/**
 * Its owner only (404 for anyone else): runs the integration's connection test. `{ok: true, accountLabel, capabilities?}`,
 * or `{ok: false, code}`; `{retryAfterMs}` when it was tested LIMITS.connectionTestsPerMinute
 * times in the last minute. Audited as `integration.test` with the outcome (it may decrypt).
 */
export async function testIntegrationConnection(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  integrationId: string,
): Promise<IntegrationTestResult | TestRateLimited> {
  const integration = await findOwnIntegration(ctx, actor.userId, integrationId);
  // Demo data is never tested against its provider: its credential is FAKE.
  if (integration.demo) throw new AppError(409, 'Demo data is not connected to a provider');
  const wait = await waitBeforeNextTest(ctx, integration.id);
  if (wait > 0) return { retryAfterMs: wait };
  const outcome = await runTest(ctx, integration);
  let result: IntegrationTestResult;
  if ('probe' in outcome) {
    result = await recordSuccess(ctx, integration, outcome.probe);
  } else {
    logFailure(integration, outcome.code, outcome.error);
    if (outcome.code === 'auth_failed') {
      // A reconnect is needed. A pause or an expiry is kept (the conditional write).
      await (
        await getIntegrationRepository()
      ).recordSyncResult(ctx.id, integration.id, {
        status: 'error',
        lastError: { code: 'auth_failed', message: SYNC_ERROR_MESSAGES.auth_failed },
      });
    }
    result = { ok: false, code: outcome.code };
  }
  await auditIntegration(
    ctx,
    actor,
    'integration.test',
    integration.id,
    result.ok ? { ok: true } : { ok: false, code: result.code },
  );
  return result;
}
