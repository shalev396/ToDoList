/**
 * A to-do integration (Jira, ClickUp, Linear, GitHub): the shared half of TaskProvider, a template
 * the provider classes fill in.
 *
 * - `createOptions` (the funnel): one step's choices, read with GETs (or allow-listed GraphQL
 *   reads) through the read client, kept for a minute per user, integration and step. In the
 *   fixtures sync mode (tests only) the provider's recorded `create-options` set answers instead.
 * - `createTask`: the one create, built by the provider class (`prepare`: typed fields only, path
 *   ids checked) and sent through the write client (writers/trackerWriter.ts), whose allow-list
 *   is the exact create endpoints. It runs inside the write session, so a read-only integration
 *   (or demo data, or a fixtures stage) never reaches the provider. The created item is read back
 *   best effort, under a short budget.
 *
 * Nothing here keeps, logs or returns a secret: the credential refuses a result that carries one
 * and redacts what is thrown.
 */
import type { Caller } from '../base/Caller.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import { cachedCreateOptions } from '../../services/providerCreate/funnel.js';
import { AppError } from '../../errors/AppError.js';
import { fixtureSetDir } from '../../sync/fixtureSets.js';
import { createReadOnlyClient, type ReadOnlyClient, type Transport } from '../../sync/http.js';
import { fixtureTransport, loadFixtureSet } from '../../sync/transports/fixtures.js';
import { liveTransport } from '../../sync/transports/live.js';
import type { AdapterContext, MappedItem } from '../../sync/types.js';
import type {
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateTarget,
} from '../../types/providerCreate.js';
import type { AuthKind, SecretJson } from './auth/AuthStrategy.js';
import type { CreatedTask, CreateTaskRequest, TaskProvider } from './capabilities.js';
import type { TestableAdapter } from './connectionTest.js';
import type { CreateRules } from './definitions/IntegrationDefinition.js';
import { Integration } from './Integration.js';
import {
  createWriteClient,
  type CreatedRecord,
  type CreateFields,
  type WriteClient,
  type WriteResult,
} from './writers/trackerWriter.js';

/** The recorded fixture set the funnel reads in the fixtures sync mode, unless the definition names one. */
export const FIXTURE_SET = 'create-options';
const CREATE_TIMEOUT_MS = 12_000;
/** The read-back may take this long; then the create is reported as is. */
const READ_BACK_BUDGET_MS = 5_000;

/**
 * What the funnel's reads and a created item's read-back run with: the integration, the headers
 * built from its opened credential, and the read client. Never a writer.
 */
export interface TrackerReadSession {
  integration: IntegrationData;
  /** How it connects (its auth strategy's kind): a GitHub App's grant reads other repositories. */
  authKind: AuthKind;
  /** Authorization (its auth strategy's) and the provider's fixed headers for its calls. */
  headers: Record<string, string>;
  read: ReadOnlyClient;
  fixtures: boolean;
}

/** A create's session: the read session and the write client for the one create. */
export interface TrackerWriteSession extends TrackerReadSession {
  write: WriteClient;
}

/** A create, validated and built, ready to send; and how its item is read back. */
export interface PreparedCreate {
  write: () => Promise<WriteResult>;
  readBack: (record: CreatedRecord) => Promise<MappedItem | null>;
}

let transportFactory: (timeoutMs: number) => Transport = (timeoutMs) =>
  liveTransport({ timeoutMs });

/** Tests only (node:test): what stands in for the network; null restores the live transport. */
export function setCreateTransportForTests(
  factory: ((timeoutMs: number) => Transport) | null,
): void {
  if ((process.env['NODE_TEST_CONTEXT'] ?? '') === '') {
    throw new Error('setCreateTransportForTests runs only under node:test');
  }
  transportFactory = factory ?? ((timeoutMs): Transport => liveTransport({ timeoutMs }));
}

/** `work`, or null when it is not done in `ms` or fails (it keeps running; its answer is dropped). */
async function within<T>(work: Promise<T>, ms: number): Promise<T | null> {
  let timer: NodeJS.Timeout | undefined;
  const late = new Promise<null>((resolve) => {
    timer = setTimeout(() => {
      resolve(null);
    }, ms);
  });
  try {
    return await Promise.race([work.catch(() => null), late]);
  } finally {
    clearTimeout(timer);
  }
}

export abstract class TrackerIntegration<
  TConfig extends object = object,
  TSecret extends SecretJson = SecretJson,
>
  extends Integration<TConfig, TSecret, TrackerWriteSession>
  implements TaskProvider
{
  /**
   * One funnel step's choices. Only for a caller who could create here now: nothing is read at a
   * provider that cannot be written to (demo data, fixtures, a read-only integration).
   */
  async createOptions(
    caller: Caller,
    query: CreateOptionsQuery,
  ): Promise<CreateOptionsResponseData> {
    this.assertWritable(caller);
    if (!this.createRules.steps.includes(query.step)) {
      throw new AppError(400, 'step: not a step of this provider');
    }
    return cachedCreateOptions(`${caller.userId}|${this.id}|${JSON.stringify(query)}`, () =>
      this.#withFunnelSession((session) => this.readOptions(session, query)),
    );
  }

  /**
   * The to-do created at the provider, inside the write session: the request is prepared (400
   * before anything is sent), sent once, and its answer handed to `request.settle` at once; then
   * the created item is read back (best effort: one attempt, a short budget).
   */
  async createTask(caller: Caller, request: CreateTaskRequest): Promise<CreatedTask> {
    const state: { result: WriteResult | null; mapped: MappedItem | null } = {
      result: null,
      mapped: null,
    };
    await this.withWriteSession(caller, async ({ writer: session }): Promise<void> => {
      const prepared = await this.prepare(session, request.target, request.fields);
      const result = await prepared.write();
      state.result = result;
      await request.settle(result);
      if (result.kind === 'created') {
        // Best effort: one attempt, a short budget; the create is already recorded.
        state.mapped = await within(prepared.readBack(result.record), READ_BACK_BUDGET_MS);
      }
    });
    if (state.result === null) throw new Error('The create ended without an answer');
    return { result: state.result, mapped: state.mapped };
  }

  /** One step's options through the read session: the definition's funnel reader. */
  protected readOptions(
    session: TrackerReadSession,
    query: CreateOptionsQuery,
  ): Promise<CreateOptionsResponseData> {
    const read = this.createRules.readOptions;
    if (read === undefined) throw new AppError(400, 'step: not a step of this provider');
    return read(session, query);
  }

  /** What can be created here (the definition's): the funnel's steps and reader. */
  protected get createRules(): CreateRules {
    const rules = this.definition?.create ?? null;
    if (rules === null) throw new Error(`${this.provider} creates nothing`);
    return rules;
  }

  /** The provider's fixed headers on every create-path call, beside the strategy's auth header. */
  protected get providerHeaders(): Record<string, string> {
    return {};
  }

  /** Validates the target and builds the one create. Throws AppError (400) before anything is sent. */
  protected abstract prepare(
    session: TrackerWriteSession,
    target: CreateTarget,
    fields: CreateFields,
  ): Promise<PreparedCreate>;

  /** The provider's write session: the live transport, the read client and the write client. */
  protected createWriter(secret: TSecret): Promise<TrackerWriteSession> {
    const transport = this.auth.transport(transportFactory(CREATE_TIMEOUT_MS));
    return Promise.resolve({
      integration: this.toJSON(),
      authKind: this.auth.kind,
      headers: { ...this.auth.headers(secret, 'write'), ...this.providerHeaders },
      read: this.readClient(transport),
      write: createWriteClient(transport, this.writeBases()),
      fixtures: false,
    });
  }

  protected probe(adapter: TestableAdapter, context: AdapterContext): Promise<unknown> {
    return adapter.test(context);
  }

  /** The read client of the funnel and the read-back (Linear adds its GraphQL documents). */
  protected readClient(transport: Transport): ReadOnlyClient {
    return createReadOnlyClient({ provider: this.provider, transport, maxRetries: 1 });
  }

  /** Sites the write client may create at beyond the fixed endpoints (Jira: its own sites). */
  protected writeBases(): string[] {
    return [];
  }

  /** The funnel's read session: the recorded set in the fixtures mode, else the credential. */
  async #withFunnelSession<T>(fn: (session: TrackerReadSession) => Promise<T>): Promise<T> {
    if (this.usesFixtures) {
      const name = this.definition?.fixtures.createOptions ?? FIXTURE_SET;
      const set = await loadFixtureSet(fixtureSetDir({ provider: this.provider }, name));
      return fn({
        integration: this.toJSON(),
        authKind: this.auth.kind,
        headers: {},
        read: this.readClient(fixtureTransport(set)),
        fixtures: true,
      });
    }
    return this.withReadSession(({ headers }) => {
      const transport = this.auth.transport(transportFactory(CREATE_TIMEOUT_MS));
      return fn({
        integration: this.toJSON(),
        authKind: this.auth.kind,
        headers: { ...headers, ...this.providerHeaders },
        read: this.readClient(transport),
        fixtures: false,
      });
    });
  }
}
