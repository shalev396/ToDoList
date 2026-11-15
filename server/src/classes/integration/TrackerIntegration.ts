/**
 * A to-do integration (Jira, ClickUp, Linear, GitHub): the shared half of TaskProvider, a template
 * the provider classes fill in.
 *
 * - `createOptions` (the funnel): one step's choices, read with GETs (or allow-listed GraphQL
 *   reads) through the read client, kept for a minute per user, integration and step. In the
 *   fixtures sync mode (tests only) the provider's recorded `create-options` set answers instead.
 * - `createTask`: the one create, built by the provider class (`prepare`: typed fields only, path
 *   ids checked) and sent through the write client (writers/trackerWriter.ts), whose allow-list
 *   is the exact create and update endpoints. It runs inside the write session, so a read-only
 *   integration (or demo data, or a fixtures stage) never reaches the provider. The created item
 *   is read back best effort, under a short budget.
 * - `updateTask` (write-back, plan Addendum A1): a template method over a mirrored item's provider
 *   fields only. The edit is validated against the item (unchanged fields dropped, a field the
 *   provider doesn't take refused), the provider's static rules checked (`checkUpdate`), then the
 *   provider class sends it (`applyUpdate`: its lookups through the read client, then its exact
 *   update requests through the write client) inside the write session, each call that goes
 *   through audited at once (WriteLedger); what the provider confirmed is saved on the item. An
 *   edit that changes nothing never opens a write session. TodoList's own fields (the overlay)
 *   are not this method's: they go through the item's overlay path.
 *
 * Nothing here keeps, logs or returns a secret: the credential refuses a result that carries one
 * and redacts what is thrown.
 */
import type { Caller } from '../base/Caller.js';
import type { IntegrationData } from '../../models/definitions/Integration.js';
import type { ItemData, MirroredItemPatch } from '../../models/definitions/Item.js';
import { getItemRepository } from '../../models/index.js';
import { logger } from '../../services/logger.js';
import { cachedCreateOptions } from '../../services/providerCreate/funnel.js';
import { AppError } from '../../errors/AppError.js';
import { WrittenNotStoredError } from '../../errors/WrittenNotStoredError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ProviderItemMissingError } from '../../errors/ProviderItemMissingError.js';
import { ProviderNoAnswerError } from '../../errors/ProviderNoAnswerError.js';
import { ProviderPartialWriteError } from '../../errors/ProviderPartialWriteError.js';
import { ScopeMissingError } from '../../errors/ScopeMissingError.js';
import { StatusNotAvailableError } from '../../errors/StatusNotAvailableError.js';
import { fixtureSetDir } from '../../sync/fixtureSets.js';
import {
  createReadOnlyClient,
  ProviderHttpError,
  type ReadOnlyClient,
  type Transport,
} from '../../sync/http.js';
import { fixtureTransport, loadFixtureSet } from '../../sync/transports/fixtures.js';
import { liveTransport } from '../../sync/transports/live.js';
import type { AdapterContext, MappedItem } from '../../sync/types.js';
import type {
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateTarget,
} from '../../types/providerCreate.js';
import type { ItemStatus } from '../../types/domain.js';
import type { WritableField } from '../../types/integrations.js';
import type { AuthKind, SecretJson } from './auth/AuthStrategy.js';
import { OAuthAuth } from './auth/OAuthAuth.js';
import type {
  CreatedTask,
  CreateTaskRequest,
  ItemRef,
  TaskPatch,
  TaskProvider,
} from './capabilities.js';
import type { TestableAdapter } from './connectionTest.js';
import type { CreateRules } from './definitions/IntegrationDefinition.js';
import { Integration } from './Integration.js';
import { TaskEdit } from './TaskEdit.js';
import type { ProviderPatch } from './writeBack.js';
import { WriteLedger } from './WriteLedger.js';
import {
  createWriteClient,
  type CreatedRecord,
  type CreateFields,
  type UpdateResult,
  type WriteClient,
  type WriteFailure,
  type WriteResult,
} from './writers/trackerWriter.js';

export type { ProviderPatch, WriteLedger };

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

/** A write the provider refused, or may have made: the AppError the caller answers. */
function writeFailure(provider: string, failure: WriteFailure): AppError {
  if (failure.kind === 'unknown') return new ProviderNoAnswerError(provider);
  switch (failure.reason) {
    case 'auth':
      return new AppError(409, `${provider} refused the connection: reconnect it`, {
        code: 'provider_refused',
      });
    case 'forbidden':
      return new AppError(409, `${provider} refused this change: the connection may not make it`, {
        code: 'provider_refused',
      });
    case 'rate_limited':
      return new AppError(429, `${provider} is busy. Try again in a moment.`);
    case 'rejected':
      return new AppError(422, `${provider} rejected this change`);
    case 'unreachable':
      // Never sent (netGuard or the allow-list): nothing was changed there.
      return new AppError(502, `${provider} could not be reached. Try again in a moment.`, {
        code: 'provider_unreachable',
      });
    case 'not_found':
      return new ProviderItemMissingError(provider);
  }
}

/** A lookup (a read) that failed before anything was written: the AppError the caller answers. */
function lookupFailure(error: ProviderHttpError): AppError {
  const { provider } = error;
  switch (error.code) {
    case 'auth_failed':
      return new AppError(409, `${provider} refused the connection: reconnect it`, {
        code: 'provider_refused',
      });
    case 'not_found':
    case 'gone':
      return new ProviderItemMissingError(provider);
    case 'rate_limited':
      return new AppError(429, `${provider} is busy. Try again in a moment.`);
    default:
      // A read before any write: nothing was changed there.
      return new AppError(502, `${provider} could not be reached. Try again in a moment.`, {
        code: 'provider_unreachable',
      });
  }
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

  /**
   * One edit of a mirrored item's provider fields, its owner's (plan Addendum A1). A template
   * method:
   * 1. validate: the edit (TaskEdit: 400 naming the field), then the item (this integration's live
   *    mirrored item: 404 otherwise);
   * 2. split against the item: a field set to what the item has is dropped (an edit that changes
   *    nothing returns the item: no write, no write gate); a changed field the provider doesn't
   *    take for the item's kind is 422 `field_not_writable`; then `checkUpdate`, the provider's
   *    static rules (a status it can't set: 422 `status_not_available`), the write gate's checks
   *    (read-only: 409) and an OAuth grant's write scope (409 `scope_missing`), all before
   *    anything is opened;
   * 3. the write session;
   * 4. `applyUpdate`: the provider class looks up what it needs, then sends; each call that goes
   *    through is confirmed to the WriteLedger, which audits it at once (`integration.write`);
   * 5. save what the provider confirmed (`source.hash` cleared, so the next sync rewrites what
   *    the provider holds).
   * When a later call fails after an earlier one went through, what went through is saved and
   * audited (`partial: true`) and the answer is ProviderPartialWriteError (409
   * `provider_partial_write`); when nothing went through, nothing is saved. The item as now stored.
   */
  async updateTask(caller: Caller, item: ItemRef, patch: TaskPatch): Promise<ItemData> {
    // 1. Validate.
    this.assertOwner(caller);
    const edit = TaskEdit.parse(patch);
    const stored = await this.#mirroredItem(item.id);
    // 2. Split against the item, then the static rules and the gate.
    const changes = edit.against(
      stored,
      this.writableFieldsFor(stored.kind),
      caller.settings.timezone,
    );
    if (changes === null) return stored;
    this.checkUpdate(stored, changes.patch);
    this.assertWritable(caller);
    // An OAuth grant from before its owner allowed writes (Jira `write:jira-work`, Linear `write`):
    // nothing is opened or sent; connecting again with writes on grants it.
    if (await this.needsWriteConsent()) {
      throw new ScopeMissingError(
        this.id,
        this.#writeScopes.join(' '),
        `${this.provider} needs a new permission to change items there: connect it again with Read & write on`,
      );
    }
    // 3 and 4. The provider's part, inside the write session; each call audited as it lands.
    // Each call that went through is audited at once; an audit that fails is logged and the write
    // goes on (the provider has it: the answer must say so).
    const ledger = new WriteLedger((fields) =>
      this.#auditAfterWrite(caller, {
        operation: 'task.update',
        itemId: stored.id,
        fields: [...fields],
      }),
    );
    try {
      await this.withWriteSession(caller, ({ writer }) =>
        this.applyUpdate(writer, stored, changes.patch, ledger),
      );
    } catch (error) {
      const failure = error instanceof ProviderHttpError ? lookupFailure(error) : error;
      const unknown = failure instanceof ProviderNoAnswerError;
      if (ledger.isEmpty) {
        // Sent, with no answer: it may have landed, so it is audited as such.
        if (unknown) {
          await this.#auditAfterWrite(caller, {
            operation: 'task.update',
            itemId: stored.id,
            fields: [...changes.fields],
            outcome: 'unknown',
          });
        }
        throw failure;
      }
      throw await this.#partial(caller, stored, changes.fields, ledger, unknown);
    }
    // 5. Save what the provider confirmed. A failure here is not "couldn't be saved": it was made.
    try {
      return await this.#save(stored, ledger.values);
    } catch (error) {
      if (error instanceof NotFoundError) throw error;
      logger.warn('A provider write could not be stored', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
      throw new WrittenNotStoredError(this.provider, ledger.fields);
    }
  }

  /**
   * The provider's static rules for `patch` on `item`, checked before the write gate and the
   * credential (no I/O): the status must be one the provider can set (`reachableStatuses`).
   * A provider class adds its own value rules (calling this first).
   */
  protected checkUpdate(_item: ItemData, patch: ProviderPatch): void {
    if (patch.status !== undefined && !this.reachableStatuses.includes(patch.status)) {
      throw new StatusNotAvailableError(this.provider, patch.status);
    }
  }

  /**
   * Sends one write-back (the changed fields of `patch`, each one the provider takes): its lookups
   * (a status to reach, what the edit screen takes) go through `session.read` first, then its
   * update requests through `session.write`. Each call that goes through is confirmed to `ledger`
   * at once, with what the provider confirmed as the item's fields. A status the provider can't
   * reach for this item is StatusNotAvailableError, a field it won't take FieldNotWritableError
   * (both 422, before anything is sent); a refusal or no answer is an AppError (answerOf).
   */
  protected abstract applyUpdate(
    session: TrackerWriteSession,
    item: ItemData,
    patch: ProviderPatch,
    ledger: WriteLedger,
  ): Promise<void>;

  /** An update's answer: the record it carried (or null) when done; otherwise its AppError. */
  protected answerOf(result: UpdateResult): Record<string, unknown> | null {
    if (result.kind === 'updated') return result.record;
    throw writeFailure(this.provider, result);
  }

  /** A status as the provider confirmed it: the normalized one, its own name, when it closed. */
  protected confirmedStatus(status: ItemStatus, raw: string | null): MirroredItemPatch {
    const closed = status === 'done' || status === 'cancelled';
    return { status, statusRaw: raw, closedAt: closed ? new Date() : null };
  }

  /** Step 5: what the provider confirmed, saved (`source.hash` cleared for the next sync). */
  async #save(stored: ItemData, confirmed: Readonly<MirroredItemPatch>): Promise<ItemData> {
    const updated = await (
      await getItemRepository()
    ).updateMirrored(this.workspaceId, this.id, stored.id, confirmed, { resync: true });
    if (updated === null) throw new NotFoundError();
    return updated;
  }

  /**
   * A write-back that stopped part-way: what reached the provider is saved (best effort: the item
   * may be gone, or the store may fail; the answer is the partial write either way) and audited as the edit's outcome (`partial: true`, with the rest as `refused`,
   * or as `uncertain` when the step that stopped it got no answer and may have landed); the error
   * to answer.
   */
  async #partial(
    caller: Caller,
    stored: ItemData,
    asked: readonly WritableField[],
    ledger: WriteLedger,
    unknown: boolean,
  ): Promise<ProviderPartialWriteError> {
    try {
      await this.#save(stored, ledger.values);
    } catch (error) {
      // The provider has what it took either way: the answer stays the partial write (never a
      // bare 500 that would say nothing was changed); the item catches up on the next sync.
      if (!(error instanceof NotFoundError)) {
        logger.warn('A partial provider write could not be stored', {
          integrationId: this.id,
          errorName: error instanceof Error ? error.name : typeof error,
        });
      }
    }
    const written = ledger.fields;
    const rest = asked.filter((field) => !written.includes(field));
    await this.#auditAfterWrite(caller, {
      operation: 'task.update',
      itemId: stored.id,
      fields: [...written],
      ...(unknown ? { uncertain: rest } : { refused: rest }),
      partial: true,
    });
    return unknown
      ? new ProviderPartialWriteError(this.provider, written, [], rest)
      : new ProviderPartialWriteError(this.provider, written, rest);
  }

  /**
   * The audit of a write the provider took, or may have: a failure here (the database gone) is
   * logged, never answered, so the answer still says what happened at the provider.
   */
  async #auditAfterWrite(caller: Caller, meta: Record<string, unknown>): Promise<void> {
    try {
      await this.recordWrite(caller, meta);
    } catch (error) {
      logger.error('A provider write could not be audited', {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  /** The scopes its OAuth grant needs to write (none for a key or token). */
  get #writeScopes(): readonly string[] {
    const auth = this.auth;
    return auth instanceof OAuthAuth ? auth.writeScopes : [];
  }

  /** This integration's live mirrored item (404 for any other, a local one included). */
  async #mirroredItem(id: string): Promise<ItemData> {
    const stored = await (await getItemRepository()).findById(this.workspaceId, id);
    if (stored?.integrationId !== this.id || stored.source.provider === 'local') {
      throw new NotFoundError();
    }
    return stored;
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
