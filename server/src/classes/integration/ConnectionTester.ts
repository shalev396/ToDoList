/**
 * "Test connection" of one integration (Integration#testConnection's collaborator): the rate
 * limit, the provider's adapter test (the integration class's `probe`: GET calls, or allow-listed
 * GraphQL reads) over the live transport or the recorded fixtures, and what a test learns.
 *
 * - live mode: the secret exists only inside the integration's read session, which builds the
 *   adapter context (the auth headers from the integration's strategy) over the live transport,
 *   runs the probe and returns only a sanitized `{accountLabel, accountId, capabilities}`;
 * - fixtures mode (tests only): the adapter's recorded fixture set and an empty secret.
 *
 * The pure pieces (the transport's guards, the deadline, the answer's sanitizing, the failure
 * codes) are connectionTest.ts's.
 */
import { AuditLog } from '../AuditLog.js';
import { LIMITS } from '../../config/limits.js';
import type { ConnectionTestPatch, IntegrationData } from '../../models/definitions/Integration.js';
import { getIntegrationRepository } from '../../models/index.js';
import { ProviderHttpError } from '../../sync/errors.js';
import { fixtureSetDir } from '../../sync/fixtureSets.js';
import type { ReadOnlyClient, Transport } from '../../sync/http.js';
import { SYNC_ERROR_MESSAGES } from '../sync/SyncRun.js';
import { fixtureTransport, loadFixtureSet } from '../../sync/transports/fixtures.js';
import type { AdapterAuth, AdapterContext, ProviderAdapter } from '../../sync/types.js';
import type { IntegrationTestResult } from '../../types/integrations.js';
import type { SecretJson } from './auth/AuthStrategy.js';
import {
  beforeDeadline,
  canTest,
  CONNECTION_TEST_TIMEOUT_MS,
  connectionTestTransport,
  failed,
  logFailure,
  NO_WAIT,
  testTransport,
  toProbe,
  type Outcome,
  type Probe,
  type TestableAdapter,
} from './connectionTest.js';
import { isPlaceholderAccountId } from './definitions/fields.js';

/** A setting a successful connection test may learn (ConnectionTestPatch, the label aside). */
export type LearnedSetting = Exclude<keyof ConnectionTestPatch, 'label'>;

/**
 * What a test needs of the integration: its data, and its protected members handed over as
 * functions by Integration (the read session, the strategy, the probe, the hooks).
 */
export interface TestSubject {
  readonly data: IntegrationData;
  readonly adapter: ProviderAdapter | null;
  readonly usesFixtures: boolean;
  /** The label it has until its owner names it (its definition's); null: no definition. */
  readonly defaultLabel: string | null;
  readonly learnedCapabilities: Readonly<Record<string, LearnedSetting>>;
  learnedLabel(accountLabel: string): string;
  hasCredential(): Promise<boolean>;
  /** The read session: the opened secret for `fn`, never a writer. */
  withSecret<T>(fn: (secret: SecretJson) => Promise<T>): Promise<T>;
  /** The strategy's transport for a session (a test's stand-in rewrite). */
  transport(inner: Transport): Transport;
  /** The strategy's auth, bound to the session. */
  auth(secret: SecretJson, client: ReadOnlyClient, now: Date): AdapterAuth;
  probe(adapter: TestableAdapter, context: AdapterContext): Promise<unknown>;
}

const RATE_WINDOW_MS = 60_000;
/** Tests audited in one workspace in a minute: at most 5 per integration, 20 integrations. */
const RECENT_TESTS_SCANNED = 200;
const NO_SECRET: SecretJson = Object.freeze({});

/** MongoDB's E11000: here, the account a pending connection learned is connected already. */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

export class ConnectionTester {
  readonly #subject: TestSubject;
  /** The audit action every test that ran is recorded as (the rate limit counts them). */
  readonly #action: string;

  constructor(subject: TestSubject, action: string) {
    this.#subject = subject;
    this.#action = action;
  }

  /**
   * How long until the integration may be tested again (0: now). Every test that ran is audited,
   * so the audit log counts them; a refused request isn't counted.
   */
  async waitBeforeNext(): Promise<number> {
    const { data } = this.#subject;
    const now = Date.now();
    const entries = await AuditLog.list(
      data.workspaceId,
      { action: this.#action, since: new Date(now - RATE_WINDOW_MS) },
      RECENT_TESTS_SCANNED,
    );
    // Newest first: the last one that still counts against the limit.
    const counted = entries.filter((entry) => entry.targetId === data.id);
    const oldest = counted[LIMITS.connectionTestsPerMinute - 1];
    if (oldest === undefined) return 0;
    return Math.max(1, oldest.at.getTime() + RATE_WINDOW_MS - now);
  }

  /**
   * The test and what it leaves: `{ok: true, accountLabel, capabilities?}` or `{ok: false,
   * code}`. `auth_failed` puts the integration in `error` (a reconnect) unless it is paused or
   * expired. On success, a `pending:` account becomes the real one (once) and a default label
   * becomes the account's own.
   */
  async run(timeZone: string): Promise<IntegrationTestResult> {
    const outcome = await this.#outcome(timeZone);
    if ('probe' in outcome) return this.#recordSuccess(outcome.probe);
    const { data } = this.#subject;
    logFailure(data, outcome.code, outcome.error);
    if (outcome.code === 'auth_failed') {
      // A reconnect is needed. A pause or an expiry is kept (the conditional write).
      await (
        await getIntegrationRepository()
      ).recordSyncResult(data.workspaceId, data.id, {
        status: 'error',
        lastError: { code: 'auth_failed', message: SYNC_ERROR_MESSAGES.auth_failed },
      });
    }
    return { ok: false, code: outcome.code };
  }

  async #outcome(timeZone: string): Promise<Outcome> {
    const subject = this.#subject;
    const adapter = subject.adapter;
    if (adapter === null) return { code: 'no_adapter' };
    if (!canTest(adapter)) return { code: 'not_supported' };
    const deadline = Date.now() + CONNECTION_TEST_TIMEOUT_MS;

    if (subject.usesFixtures) {
      let transport: Transport;
      try {
        transport = fixtureTransport(await loadFixtureSet(fixtureSetDir(adapter)));
      } catch (error) {
        return { code: 'fixtures_missing', error };
      }
      try {
        return { probe: await this.#probeWith(adapter, timeZone, NO_SECRET, transport, deadline) };
      } catch (error) {
        return failed(error);
      }
    }

    if (!(await subject.hasCredential())) return { code: 'credential_missing' };
    // An object, so the callback's write is seen after the await (a flag would stay narrowed).
    const progress = { opened: false };
    try {
      const found = await subject.withSecret((secret) => {
        progress.opened = true;
        const transport = subject.transport(connectionTestTransport());
        return this.#probeWith(adapter, timeZone, secret, transport, deadline);
      });
      return { probe: found };
    } catch (error) {
      // Thrown before the callback ran: the credential could not be opened.
      // A refused OAuth refresh happens before the callback: it is the provider saying reconnect.
      if (progress.opened || (error instanceof ProviderHttpError && error.code === 'auth_failed')) {
        return failed(error);
      }
      return { code: 'credential_unavailable', error };
    }
  }

  /** The probe over `transport`, with `secret` (`{}` in fixtures mode), within the deadline. */
  async #probeWith(
    adapter: TestableAdapter,
    timeZone: string,
    secret: SecretJson,
    transport: Transport,
    deadline: number,
  ): Promise<Probe> {
    const subject = this.#subject;
    const client = adapter.createClient(testTransport(transport, deadline), NO_WAIT);
    const now = new Date();
    const context: AdapterContext = {
      integration: subject.data,
      // The headers come from the integration's auth strategy, never from the adapter.
      auth: subject.auth(secret, client, now),
      client,
      now,
      timeZone,
      fullSyncDue: false,
    };
    return toProbe(await beforeDeadline(subject.probe(adapter, context), deadline));
  }

  /**
   * A pending account becomes the real one (once); a default label becomes the account's own;
   * what the provider class learns from the probe is recorded. The label and the settings are
   * written field by field (recordConnectionTest), so a label or config saved while the test ran
   * is kept.
   */
  async #recordSuccess(found: Probe): Promise<IntegrationTestResult> {
    const subject = this.#subject;
    const { data } = subject;
    const integrations = await getIntegrationRepository();
    if (isPlaceholderAccountId(data.accountId)) {
      try {
        await integrations.replacePendingAccount(
          data.workspaceId,
          data.id,
          found.accountId ?? found.accountLabel,
        );
      } catch (error) {
        if (isDuplicateKey(error)) return { ok: false, code: 'already_connected' };
        throw error;
      }
    }
    const learned: ConnectionTestPatch = {};
    const label = subject.defaultLabel;
    if (label !== null && data.label === label && found.accountLabel !== label) {
      learned.label = { from: label, to: subject.learnedLabel(found.accountLabel) };
    }
    for (const [capability, setting] of Object.entries(subject.learnedCapabilities)) {
      const value = found.capabilities?.[capability];
      if (value !== undefined) learned[setting] = value;
    }
    if (learned.label !== undefined || learned.boardsEnabled !== undefined) {
      await integrations.recordConnectionTest(data.workspaceId, data.id, learned);
    }
    return {
      ok: true,
      accountLabel: found.accountLabel,
      ...(found.capabilities === null ? {} : { capabilities: found.capabilities }),
    };
  }
}
