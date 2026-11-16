/**
 * Integrations (DATA.md §3.4, §4, §5; BACKEND.md §4; PERMISSIONS-V2): one connection of one
 * member to one provider account. `Integration` is the abstract base every provider class
 * extends (providers/*), and the only code that reads or writes integrations and their
 * credentials.
 *
 * What every integration has:
 * - its credential (`#credential`, private: only the read and write sessions below open it);
 * - its auth strategy (`auth`): OAuth, an API key, or the demo's service account;
 * - its mode (`Mode`): read-only by default, read & write only after its owner switches it.
 *
 * Ownership (IntegrationPolicy): editors and owners connect their own (viewers are refused,
 * ruling 9); everything else (the config, an edit, the mode, a test, a sync, a disconnect, stop
 * sharing) is its owner's alone, whatever their role (ruling 10). For anyone else the integration
 * does not exist (404), workspace owners included.
 *
 * The write gate (the read-only rule) is the protected `withWriteSession`: the only way to a
 * provider writer, so only provider subclasses write, and only inside their capability methods
 * (capabilities.ts). It refuses demo data and fixtures first (`provider_writes_off`), then a
 * read-only integration (ReadOnlyIntegrationError, 409 `integration_read_only`).
 *
 * Integration stays the one public base; it hands parts of its work to collaborators, giving them
 * only what they need (its protected members as functions, never the credential itself):
 * IntegrationConnector (a new integration, within the caps), ConnectionTester ("test
 * connection") and SyncRequest ("sync now"). What each provider is lives in its class's
 * `static definition` (definitions/*).
 */
import type { ActorRef } from '../base/Actor.js';
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, Owned, SoftDeletable, Viewable } from '../base/contracts.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { AuditLog, type AuditScope } from '../AuditLog.js';
import { IntegrationPolicy } from '../policies/IntegrationPolicy.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { AppError } from '../../errors/AppError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ReadOnlyIntegrationError } from '../../errors/ReadOnlyIntegrationError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { ErrorInfo } from '../../models/definitions/common.js';
import {
  toIntegrationStatus,
  type IntegrationData,
  type IntegrationPatch,
  type IntegrationStatusView,
} from '../../models/definitions/Integration.js';
import { getIntegrationRepository, getWorkspaceRepository } from '../../models/index.js';
import { EMPTY_UPDATE_MESSAGE } from '../../services/integrationConfig.js';
import { logger } from '../../services/logger.js';
import { writeModeFor } from '../../services/providerCreate/mode.js';
import { SyncCursors } from '../sync/SyncCursors.js';
import { SyncedRows } from '../sync/SyncedRows.js';
import { SyncEngine, type SyncTarget } from '../sync/SyncEngine.js';
import type { SyncRunOptions } from '../sync/SyncOptions.js';
import { skippedRun, zeroCounts } from '../sync/syncRecords.js';
import { SyncRun } from '../sync/SyncRun.js';
import { Topic } from '../workspace/Topic.js';
import { Dashboard } from '../dashboard/Dashboard.js';
import '../../sync/providers/index.js';
import { getAdapter } from '../../sync/registry.js';
import { syncModeFor } from '../../sync/syncMode.js';
import type { AdapterContext, ProviderAdapter, SyncRunSummary } from '../../sync/types.js';
import {
  PROVIDERS,
  type AuthMethod,
  type IntegrationMode,
  type IntegrationStatus,
  type ItemKind,
  type ItemStatus,
  type Provider,
  type SyncTrigger,
} from '../../types/domain.js';
import type {
  IntegrationTestResult,
  ProviderCapabilities,
  WritableField,
} from '../../types/integrations.js';
import type { AuthKind, AuthStrategy, SecretJson } from './auth/AuthStrategy.js';
import { OAuthAuth } from './auth/OAuthAuth.js';
import { UnofferedAuth } from './auth/UnofferedAuth.js';
import {
  isAddedContentRemover,
  isCalendarProvider,
  type AddedRemoval,
  isCreateFunnel,
  isResourcePicker,
  isRevocable,
  isTaskProvider,
} from './capabilities.js';
import type { TestableAdapter, TestRateLimited } from './connectionTest.js';
import { ConnectionTester, type LearnedSetting, type TestSubject } from './ConnectionTester.js';
import { Credential } from './Credential.js';
import {
  DEFINITIONS,
  strategyForMethod,
  type ConnectionInput,
  type IntegrationDefinition,
  type PickerKind,
} from './definitions/index.js';
import {
  CREDENTIAL_MISSING,
  IntegrationConnector,
  type ConnectedIntegration,
  type OAuthConnection,
} from './IntegrationConnector.js';
import { IntegrationRegistry } from './IntegrationRegistry.js';
import { Mode } from './Mode.js';
import { SyncRequest, type SyncSubject } from './SyncRequest.js';

export type { TestRateLimited };

/** What an owner may change: never the provider, the account, the status or the secret. */
export interface IntegrationUpdate {
  label?: string | undefined;
  /** A topic of the workspace; null = none (Unsorted). */
  topicId?: string | null | undefined;
  config?: Record<string, unknown> | undefined;
  /** null clears it. */
  expiresAt?: Date | null | undefined;
}

export type SyncRequestOutcome = { runId: string } | { retryAfterMs: number };

/** A credential opened for one call: the secret and the provider headers built from it. */
export interface ReadSession<TSecret extends SecretJson> {
  readonly secret: TSecret;
  readonly headers: Readonly<Record<string, string>>;
}

/** A read session that may also change the provider: what only withWriteSession hands out. */
export interface WriteSession<TSecret extends SecretJson, TWriter> extends ReadSession<TSecret> {
  readonly writer: TWriter;
}

export { CREDENTIAL_MISSING, type ConnectedIntegration, type OAuthConnection };

/** Codes of a run for an integration that waits for the user: it is not synced. */
const HELD_RUN_CODES: Partial<Record<IntegrationStatus, 'skipped_paused' | 'skipped_expired'>> = {
  paused: 'skipped_paused',
  expired: 'skipped_expired',
};

const writesOff = (): AppError =>
  new AppError(409, 'Creating in providers is off on this server', { code: 'provider_writes_off' });

export abstract class Integration<
  TConfig extends object = object,
  TSecret extends SecretJson = SecretJson,
  TWriter = unknown,
>
  extends WorkspaceEntity<IntegrationData>
  implements Owned, Auditable, SoftDeletable, Viewable<IntegrationStatusView>
{
  /** The audit actions an integration records, by name (DATA.md §3.10). */
  static readonly Audit = Object.freeze({
    create: 'integration.create',
    update: 'integration.update',
    mode: 'integration.mode',
    test: 'integration.test',
    disconnect: 'integration.disconnect',
    stopSharing: 'integration.stop_sharing',
    /** A change made at the provider for an item or a calendar (write-back): field names only. */
    write: 'integration.write',
    /** What TodoList added at the provider, taken back before a disconnect: counts only. */
    cleanup: 'integration.cleanup',
  });

  readonly #credential: Credential<TSecret>;

  protected constructor(data: IntegrationData) {
    super(data);
    this.#credential = Credential.of<TSecret>(data.id);
  }

  // ─── Factories and reads ─────────────────────────────────────────────────

  /** The provider's class for stored data (IntegrationRegistry). */
  static from(data: IntegrationData): Integration {
    return IntegrationRegistry.instance.create(data);
  }

  /**
   * The caller's own live integration in their workspace; 404 for anything else: another
   * member's, another workspace's, a deleted one or an id that never existed all read the same.
   */
  static async findOwn(caller: Caller, integrationId: string): Promise<Integration> {
    const repository = await getIntegrationRepository();
    return Integration.#owned(caller, await repository.findById(caller.workspaceId, integrationId));
  }

  /** findOwn, soft-deleted ones too: a disconnect that stopped part-way resumes. */
  static async findOwnIncludingDeleted(
    caller: Caller,
    integrationId: string,
  ): Promise<Integration> {
    const repository = await getIntegrationRepository();
    return Integration.#owned(
      caller,
      await repository.findIncludingDeleted(caller.workspaceId, integrationId),
    );
  }

  /** The caller's own live integrations in their workspace, oldest first. */
  static async listOwn(caller: Caller): Promise<Integration[]> {
    const repository = await getIntegrationRepository();
    return (await repository.listForOwner(caller.workspaceId, caller.userId)).map((data) =>
      Integration.from(data),
    );
  }

  /** The live integrations of the workspace the caller may read (IntegrationPolicy), oldest first. */
  static async listVisible(caller: Caller): Promise<Integration[]> {
    const repository = await getIntegrationRepository();
    return (await repository.list(caller.workspaceId))
      .filter((data) => caller.can(IntegrationPolicy.instance, 'read', data))
      .map((data) => Integration.from(data));
  }

  /** Global, by id (the workers know nothing else); null when missing or deleted. */
  static async forWorker(integrationId: string): Promise<Integration | null> {
    const data = await (await getIntegrationRepository()).findByIdForWorker(integrationId);
    return data === null ? null : Integration.from(data);
  }

  /** Global, by id: whether it is still connected (not deleted), without making its class. */
  static async isConnected(integrationId: string): Promise<boolean> {
    return (await (await getIntegrationRepository()).findByIdForWorker(integrationId)) !== null;
  }

  /** What the sync dispatchers schedule (IIntegrationRepository.listActiveForDispatch). */
  static async listForDispatch(): Promise<Integration[]> {
    return (await (await getIntegrationRepository()).listActiveForDispatch()).map((data) =>
      Integration.from(data),
    );
  }

  /** Each member's providers here (their own live integrations), deduplicated, in a fixed order. */
  static async providersByMember(workspaceId: string): Promise<Map<string, Provider[]>> {
    const byMember = new Map<string, Set<Provider>>();
    for (const integration of await (await getIntegrationRepository()).list(workspaceId)) {
      const providers = byMember.get(integration.ownerUserId) ?? new Set<Provider>();
      providers.add(integration.provider);
      byMember.set(integration.ownerUserId, providers);
    }
    return new Map(
      [...byMember].map(([userId, providers]) => [
        userId,
        PROVIDERS.filter((provider) => providers.has(provider)),
      ]),
    );
  }

  /** The ids of the caller's own integrations that are shared: a connector on some block. */
  static async sharedOwnIds(caller: Caller): Promise<string[]> {
    const [own, shared] = await Promise.all([
      Integration.listOwn(caller),
      ItemPolicy.sharedConnectorIds(caller.workspaceId),
    ]);
    return own.filter((integration) => shared.has(integration.id)).map(({ id }) => id);
  }

  /**
   * The sync engine's read session (through sync/secrets.ts, which holds the tests' vault seam):
   * the integration's opened secret for `fn`, never a writer. Read again by id, so a run whose
   * integration was disconnected meanwhile opens nothing: 404 when it is missing or deleted.
   */
  static async withSyncSecret<T>(
    integrationId: string,
    fn: (secret: SecretJson) => Promise<T>,
  ): Promise<T> {
    const integration = await Integration.forWorker(integrationId);
    if (integration === null) throw new AppError(404, 'Integration not found');
    return integration.withReadSession((session) => fn(session.secret));
  }

  /**
   * What each connectable provider can do and how it connects, read from its class: its
   * definition (auth methods, picker, revoke page, the write scopes its OAuth grant needs, coming
   * soon, the fields a write-back sends) and
   * the contracts its class implements (ResourcePicker, Revocable, CreateFunnel, TaskProvider or
   * CalendarProvider for a write-back). In the order of CONNECTABLE_PROVIDERS.
   */
  static capabilitiesOf(): ProviderCapabilities[] {
    return DEFINITIONS.flatMap((definition) => {
      const cls = IntegrationRegistry.instance.classOf(definition.provider);
      // Every definition has its class (the definitions test): a missing one is a wiring mistake.
      if (cls === null)
        throw new Error(`No integration class is registered for ${definition.provider}`);
      const can = cls.prototype;
      const canUpdate =
        (isTaskProvider(can) || isCalendarProvider(can)) && definition.writableFields.length > 0;
      return [
        {
          provider: definition.provider,
          authMethods: definition.userAuthMethods,
          picker: isResourcePicker(can) ? definition.picker : null,
          revokesOnDisconnect: isRevocable(can),
          needsWriteScope: (definition.auth.oauth?.writeScopes.length ?? 0) > 0,
          revokePage: definition.revokePage,
          canCreate: isCreateFunnel(can) && definition.create !== null,
          canUpdate,
          writableFields: canUpdate ? [...definition.writableFields] : [],
          writableKinds: canUpdate ? [...definition.writableKinds] : [],
          reachableStatuses: canUpdate ? [...definition.reachableStatuses] : [],
          comingSoon: definition.comingSoon,
        },
      ];
    });
  }

  static #owned(caller: Caller, data: IntegrationData | null): Integration {
    if (data === null || !caller.can(IntegrationPolicy.instance, 'read', data)) {
      throw new NotFoundError();
    }
    return Integration.from(data);
  }

  // ─── Connecting ──────────────────────────────────────────────────────────

  /** How a new integration comes to be (IntegrationConnector): the factory and the connect hook. */
  static readonly #connector = new IntegrationConnector({
    from: (data): Integration => Integration.from(data),
    onConnected: (integration): Promise<Record<string, unknown>> => integration.onConnected(),
    createdAction: Integration.Audit.create,
  });

  /**
   * Editors and owners: a new integration of their own, connected with a key or token
   * (IntegrationConnector#connectWithKey). It is read-only, and `error` until `PUT …/credential`
   * saves its credential. 409 at either cap and for an account this member already connected here.
   * Audited as `integration.create`.
   */
  static connectWithKey(
    caller: Caller,
    input: ConnectionInput,
    options: { demo?: boolean } = {},
  ): Promise<Integration> {
    return Integration.#connector.connectWithKey(caller, input, options);
  }

  /**
   * The ONE way an OAuth result becomes an integration (Google Calendar, GitHub, Jira, ClickUp,
   * Linear): create it for the provider account, or reconnect the one the member has
   * (IntegrationConnector#upsertOAuth: the ownership rules), seal the credential, clear the
   * failures it left, and mark it active. The caller has checked that the grant is what the
   * integration needs.
   */
  static async connectOAuth(caller: Caller, conn: OAuthConnection): Promise<ConnectedIntegration> {
    const result = await Integration.#connector.upsertOAuth(caller, conn);
    const { integration } = result;
    const workspaceId = caller.workspaceId;
    await Credential.seal(
      {
        workspaceId,
        integrationId: integration.id,
        provider: conn.provider,
        ownerUserId: caller.userId,
        kind: 'oauth',
        scopes: conn.scopes,
        secret: conn.secret,
      },
      caller.actor,
    );
    // Connected (again): failed runs start from 0, the account's name is its label.
    await SyncCursors.of(integration).resetFailures();
    const updated = await (
      await getIntegrationRepository()
    ).update(workspaceId, integration.id, {
      status: 'active',
      lastError: null,
      expiresAt: null,
      label: conn.label,
    });
    return {
      integration: updated === null ? integration : Integration.from(updated),
      created: result.created,
    };
  }

  /**
   * Every integration a member owns in the workspace, disconnected (the disconnect steps): they
   * left or were removed (ruling 6), or their account is being deleted. Their soft-deleted ones go
   * through the steps again too, so a disconnect that stopped part-way loses its credential and
   * items on the next try; for a finished one the steps change nothing. Their connectors stay on
   * blocks as ids of an integration that is gone, which those blocks show as "A source was
   * removed" until edited. Their local to-dos stay. `actor` (who ended the membership) is
   * recorded. Returns how many it touched.
   */
  static async disconnectAllOf(
    workspaceId: string,
    actor: ActorRef,
    memberUserId: string,
  ): Promise<number> {
    const theirs = await (
      await getIntegrationRepository()
    ).listForOwnerIncludingDeleted(workspaceId, memberUserId);
    for (const data of theirs)
      await Integration.from(data).#disconnectSteps({ workspaceId, actor });
    return theirs.length;
  }

  /**
   * Removes every integration of a workspace that is being deleted: the credentials first,
   * hard-deleted and checked gone, so nothing can decrypt for it any more; then the integrations
   * themselves, soft-deleted (the sync dispatcher stops scheduling them). Idempotent.
   */
  static async removeAllIn(workspaceId: string): Promise<void> {
    const integrations = await getIntegrationRepository();
    const live = await integrations.list(workspaceId);
    await Credential.destroyAllIn(
      workspaceId,
      live.map((integration) => integration.id),
    );
    await integrations.softDeleteForWorkspace(workspaceId);
  }

  /**
   * The owners of the integrations a workspace deletion removed, even when it resumes after
   * deleting them: the members to tell.
   */
  static async ownersRemovedWith(workspaceId: string): Promise<string[]> {
    return (await getIntegrationRepository()).listOwnersForWorkspaceDeletion(workspaceId);
  }

  /** A topic was deleted: the workspace's integrations whose default it was now default to none. */
  static async unsetTopicIn(workspaceId: string, topicId: string): Promise<number> {
    return (await getIntegrationRepository()).unsetTopic(workspaceId, topicId);
  }

  // ─── What every integration is ───────────────────────────────────────────

  get provider(): Provider {
    return this.data.provider;
  }

  get accountId(): string {
    return this.data.accountId;
  }

  get label(): string {
    return this.data.label;
  }

  get authMethod(): AuthMethod {
    return this.data.authMethod;
  }

  get topicId(): string | null {
    return this.data.topicId;
  }

  get mode(): Mode {
    return Mode.of(this.data.mode);
  }

  /** The non-secret settings, typed per provider (as stored: validated when they were saved). */
  get config(): Readonly<TConfig> {
    return this.data.config as Readonly<TConfig>;
  }

  get credentialId(): string | null {
    return this.data.credentialId;
  }

  get status(): IntegrationData['status'] {
    return this.data.status;
  }

  get expiresAt(): Date | null {
    return this.data.expiresAt;
  }

  get lastSyncAt(): Date | null {
    return this.data.lastSyncAt;
  }

  get lastError(): Readonly<ErrorInfo> | null {
    return this.data.lastError;
  }

  /** Demo data: a FAKE credential, never synced, tested or written to. */
  get demo(): boolean {
    return this.data.demo;
  }

  get ownerUserId(): string {
    return this.data.ownerUserId;
  }

  get connectedBy(): string {
    return this.data.connectedBy;
  }

  get deletedAt(): Date | null {
    return this.data.deletedAt;
  }

  get isDeleted(): boolean {
    return this.data.deletedAt !== null;
  }

  get createdAt(): Date {
    return this.data.createdAt;
  }

  isOwnedBy(userId: string): boolean {
    return IntegrationPolicy.isOwn(this.data, userId);
  }

  auditTarget(): AuditTarget {
    return AuditTarget.integration(this.id);
  }

  /** What the API and the UI may show, to its owner only. */
  toView(): IntegrationStatusView {
    return { ...toIntegrationStatus(this.toJSON()), canSwitchMode: this.canSwitchMode };
  }

  /** How it connects: its auth strategy's kind (`oauth`, `api_key`, `service_account`). */
  get authKind(): AuthKind {
    return this.auth.kind;
  }

  /**
   * Whether this connection can create items at its provider at all (its definition's create
   * rules, for its way of connecting): Google Calendar only with its OAuth grant, never the demo's
   * service account. Whether it may now is `allowsWrites`.
   */
  get canCreate(): boolean {
    return this.definition?.create?.authKinds.includes(this.authKind) ?? false;
  }

  /**
   * May TodoList write to this provider now: writes are on for it on this server (never for demo
   * data or a fixtures stage's tracker) and its owner switched it to read & write.
   */
  get allowsWrites(): boolean {
    return writeModeFor(this.data) !== 'off' && this.mode.allowsWrites;
  }

  /**
   * The write gate's checks, in order, for a caller about to write: the integration is theirs
   * (404 otherwise); writes are on for it here (409 `provider_writes_off`: demo data, fixtures);
   * it is read & write (ReadOnlyIntegrationError). withWriteSession runs them again before it
   * opens anything; callers run them first to refuse before they reserve or record anything.
   */
  assertWritable(caller: Caller): void {
    this.assertOwner(caller);
    if (writeModeFor(this.data) === 'off') throw writesOff();
    if (!this.mode.allowsWrites) throw new ReadOnlyIntegrationError(this.id);
  }

  /**
   * Does this OAuth grant lack the scopes that write to its provider (Jira `write:jira-work`,
   * Linear `write`): a write-back needs them all. A key or token: no.
   */
  async needsWriteConsent(): Promise<boolean> {
    const auth = this.auth;
    if (!(auth instanceof OAuthAuth)) return false;
    return this.lacksScopes(auth.writeScopes);
  }

  /**
   * Does this OAuth grant lack what creating an item there needs: the write scopes, or one of the
   * scopes that create on their own (Linear's older `issues:create`)?
   */
  async needsCreateConsent(): Promise<boolean> {
    const auth = this.auth;
    if (!(auth instanceof OAuthAuth)) return false;
    if (!(await this.lacksScopes(auth.writeScopes))) return false;
    const granted = new Set((await Credential.meta(this.workspaceId, this.id))?.scopes ?? []);
    return !auth.createScopes.some((scope) => granted.has(scope));
  }

  // ─── Its owner's operations ──────────────────────────────────────────────

  /**
   * The non-secret config, parsed and validated again, so only the provider's schema fields come
   * back (a credential is never in config). A stored config that no longer validates is never
   * answered as stored: 409.
   */
  readConfig(caller: Caller): Record<string, unknown> {
    this.assertOwner(caller);
    const definition = this.definition;
    if (definition === null) {
      throw new AppError(409, 'This integration has no settings to show');
    }
    try {
      return definition.parseConfig(this.toJSON().config);
    } catch (error) {
      if (!(error instanceof AppError)) throw error;
      throw new AppError(409, 'This integration’s settings no longer validate: save them again');
    }
  }

  /**
   * The label, the topic, the config (validated again; it must stay on the same account) and
   * `expiresAt` (or null). Never the provider, the account, the status or the secret. Audited as
   * `integration.update` with the names of the changed fields, never their values.
   */
  async update(caller: Caller, input: IntegrationUpdate): Promise<Integration> {
    this.assertOwner(caller);
    const patch: IntegrationPatch = {};
    if (input.label !== undefined) patch.label = input.label;
    if (input.topicId !== undefined) {
      if (input.topicId !== null) await Topic.assertOf(this.workspaceId, input.topicId);
      patch.topicId = input.topicId;
    }
    if (input.config !== undefined) {
      const definition = this.definition;
      if (definition === null) {
        throw new AppError(400, 'config: this integration has no settings to change');
      }
      const config = definition.parseConfig(input.config);
      definition.assertSameAccount(this.toJSON(), config);
      // A Jira site or ClickUp workspace is only one the grant covers (checked here, not just in the UI).
      patch.config = await this.checkSelection(config);
    }
    if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt;
    const changed = Object.keys(patch);
    if (changed.length === 0) {
      throw new AppError(400, EMPTY_UPDATE_MESSAGE);
    }
    const updated = await (
      await getIntegrationRepository()
    ).update(this.workspaceId, this.id, patch);
    if (updated === null) throw new NotFoundError();
    await AuditLog.record(caller, Integration.Audit.update, this, { changed });
    return Integration.from(updated);
  }

  /**
   * Whether the caller may switch it to `mode`, before anything is written (a request that also
   * changes other fields checks this first, so it is all or nothing): its owner only (404), and
   * never demo data to read & write (400: its credential is FAKE). The mode, as a Mode.
   */
  checkMode(caller: Caller, mode: Mode | IntegrationMode): Mode {
    this.assertOwner(caller);
    const next = Mode.of(mode);
    if (next.allowsWrites && !this.canSwitchMode) {
      throw new ValidationError('Demo data is never written to its provider');
    }
    return next;
  }

  /** Whether its owner may switch it to read & write: never demo data. */
  get canSwitchMode(): boolean {
    return !this.demo;
  }

  /**
   * Its owner switches the integration between read-only and read & write. Demo data refuses read
   * & write (400): its credential is FAKE. The same mode again changes nothing. Audited as
   * `integration.mode` with the modes before and after.
   */
  async setMode(caller: Caller, mode: Mode | IntegrationMode): Promise<Integration> {
    const next = this.checkMode(caller, mode);
    const previous = this.mode;
    if (next.equals(previous)) return this;
    const updated = await (
      await getIntegrationRepository()
    ).update(this.workspaceId, this.id, { mode: next.name });
    if (updated === null) throw new NotFoundError();
    await AuditLog.record(caller, Integration.Audit.mode, this, {
      from: previous.name,
      to: next.name,
    });
    return Integration.from(updated);
  }

  /**
   * The demo data's stand-in for a first connection test (seed/seedWorkspace.ts): a demo
   * integration's `pending:` placeholder account becomes `accountId`, once, so a later run finds
   * it again. Null when it already has its account (or is gone); an account already connected here
   * throws E11000, as a connection test's would. Any other integration is refused (409): its
   * account is proven only by a connection test. dashboardInternals.test.ts pins who may call it.
   */
  async pinAccount(accountId: string): Promise<Integration | null> {
    if (!this.demo) {
      throw new AppError(409, 'Only a demo integration takes an account without a connection test');
    }
    const pinned = await (
      await getIntegrationRepository()
    ).replacePendingAccount(this.workspaceId, this.id, accountId);
    return pinned === null ? null : Integration.from(pinned);
  }

  /**
   * Saves the credential (any role: a reconnect is not a new integration, ruling 10). `body` is
   * the secret JSON as received; a shape that doesn't fit the auth method is a 400 with one fixed
   * message. Saving a credential (again) is how an owner (re)connects: the integration becomes
   * `active` with no error, whatever it was, and a replacement (rotation) also clears `expiresAt`
   * (the old token's expiry). Audited as `integration.connect` (the first) or `credential.rotate`,
   * without secret data.
   */
  async saveCredential(caller: Caller, body: unknown): Promise<void> {
    this.assertOwner(caller);
    const { workspaceId, id } = this;
    const secret = this.auth.parseCredential(this.authMethod, body);
    const rotating = (await Credential.meta(workspaceId, id)) !== null;
    await Credential.seal(
      {
        workspaceId,
        integrationId: id,
        provider: this.provider,
        ownerUserId: caller.userId,
        kind: this.authMethod,
        secret,
      },
      caller.actor,
    );
    // Reconnected: failed runs in a row start again from 0, and the status they left is cleared,
    // with the old token's expiry when this one replaces it (one update).
    await SyncCursors.of(this).resetFailures();
    await (
      await getIntegrationRepository()
    ).update(workspaceId, id, {
      status: 'active',
      lastError: null,
      ...(rotating ? { expiresAt: null } : {}),
    });
  }

  /**
   * "Test connection" (BACKEND.md §4, DATA.md §3.5), a template method: the provider's adapter
   * test (`probe`: GET calls, or allow-listed GraphQL reads) says which account the credential
   * reaches.
   * - live mode: the secret exists only inside the read session, which builds the adapter context
   *   over the live transport, runs the probe and returns only a sanitized
   *   `{accountLabel, accountId, capabilities}`;
   * - fixtures mode (tests only): the adapter's recorded fixture set and an empty secret.
   * `{ok: true, accountLabel, capabilities?}` or `{ok: false, code}`; `{retryAfterMs}` when it was
   * tested LIMITS.connectionTestsPerMinute times in the last minute. `auth_failed` puts the
   * integration in `error` (a reconnect) unless it is paused or expired. On success, a `pending:`
   * account becomes the real one (once) and a default label becomes the account's own. Audited as
   * `integration.test` with the outcome (it may decrypt).
   */
  async testConnection(caller: Caller): Promise<IntegrationTestResult | TestRateLimited> {
    this.assertOwner(caller);
    // Demo data is never tested against its provider: its credential is FAKE.
    if (this.demo) throw new AppError(409, 'Demo data is not connected to a provider');
    const tester = new ConnectionTester(this.#testSubject(), Integration.Audit.test);
    const wait = await tester.waitBeforeNext();
    if (wait > 0) return { retryAfterMs: wait };
    const result = await tester.run(caller.settings.timezone);
    await AuditLog.record(
      caller,
      Integration.Audit.test,
      this,
      result.ok ? { ok: true } : { ok: false, code: result.code },
    );
    return result;
  }

  /**
   * "Sync now": refused (409) while it waits for its owner, like the dispatcher skips it (demo
   * data, paused, expired, failed auth; in live mode, no credential yet); `{retryAfterMs}` while a
   * manual sync of it is less than LIMITS.manualSyncIntervalMs old. A failure to queue the run is
   * a 503.
   */
  async requestSync(caller: Caller): Promise<SyncRequestOutcome> {
    this.assertOwner(caller);
    const request = new SyncRequest(this.#syncSubject());
    const hold = await request.hold();
    if (hold !== null) throw new AppError(409, SyncRequest.HOLD_MESSAGES[hold]);
    const wait = await request.manualWait();
    if (wait > 0) return { retryAfterMs: wait };
    return { runId: await request.enqueue(caller) };
  }

  /**
   * "Sync now" for every integration the caller owns here and can sync. Those waiting for them or
   * synced manually less than the interval ago are skipped. 503 only when nothing could be queued
   * because the queue failed.
   */
  static async requestSyncAll(caller: Caller): Promise<{ runIds: string[] }> {
    const runIds: string[] = [];
    let queueFailures = 0;
    for (const integration of await Integration.listOwn(caller)) {
      const request = new SyncRequest(integration.#syncSubject());
      if ((await request.hold()) !== null) continue;
      if ((await request.manualWait()) > 0) continue;
      try {
        runIds.push(await request.enqueue(caller));
      } catch (error) {
        if (!(error instanceof AppError)) throw error;
        queueFailures += 1;
      }
    }
    if (runIds.length === 0 && queueFailures > 0) {
      throw new AppError(503, 'Could not queue the sync. Try again later.');
    }
    return { runIds };
  }

  // ─── The sync (a template method; the engine is its collaborator) ────────

  /**
   * One sync of one integration, by id, whoever started it: the sync worker (a job naming its
   * queued run) or the demo seed (a trigger). Gone (disconnected): nothing is synced, and a queued
   * or running run named by `runId` ends `failed` with `integration_deleted`. Otherwise its `sync`.
   */
  static async runSync(integrationId: string, options: SyncRunOptions): Promise<SyncRunSummary> {
    const now = options.now ?? new Date();
    const data = await (await getIntegrationRepository()).findByIdForWorker(integrationId);
    if (data === null) return Integration.#endRunOfGone(integrationId, null, options, now);
    return Integration.from(data).sync(options, now);
  }

  /**
   * Queues one background sync of the integration `integrationId` and starts its job
   * (SyncRun.request), for `caller` (its owner: "Sync now") or the system (null: the dispatcher).
   * The integration is read again by id (global), so one disconnected meanwhile is never queued.
   */
  static async requestRun(
    integrationId: string,
    trigger: SyncTrigger,
    caller: Caller | null = null,
  ): Promise<SyncRun> {
    const integration = await Integration.forWorker(integrationId);
    if (integration === null) throw new Error('Integration.requestRun: integration not found');
    return SyncRun.request(caller, integration, trigger);
  }

  /**
   * One sync of this integration (BACKEND.md §5, DATA.md §4), a template method; its provider's
   * adapter is the strategy that fetches and maps, the engine (SyncEngine) does the rest:
   * 1. its workspace is read here (its time zone, its topic rules); gone: its run ends as above;
   * 2. a paused or expired integration is not synced: its run ends `failed` at once;
   * 3. its run opens (SyncRun.openFor: a new one, or the queued one its job names);
   * 4. inside its read session (fixtures: an empty secret), for each resource the adapter lists:
   *    fetch and map, then the container and item upserts (SyncedRows), its cursor (SyncCursors),
   *    and a sweep of what a full listing no longer has; then the resources no longer listed;
   * 5. the run finishes (succeeded, partial or failed), then the integration's status and the
   *    `sync.run` audit entry. A run that throws before its final write ends failed (never left
   *    `running`), and the throw goes on to the caller.
   */
  async sync(
    options: SyncRunOptions,
    now: Date = options.now ?? new Date(),
  ): Promise<SyncRunSummary> {
    const data = this.toJSON();
    const workspace = await (await getWorkspaceRepository()).findById(this.workspaceId);
    if (workspace === null) return Integration.#endRunOfGone(this.id, data, options, now);
    const held = HELD_RUN_CODES[this.status];
    if (held !== undefined) {
      const error = SyncRun.error(held);
      const counts = zeroCounts();
      const run = await SyncRun.skipFor(this, options, now, error, { ...counts });
      if (run === null) return skippedRun();
      logger.info('sync skipped', { runId: run.id, integrationId: this.id, code: held });
      return { runId: run.id, status: 'failed', counts, error };
    }
    const clock = { now, wallStart: Date.now() };
    const run = await SyncRun.openFor(this, options, now);
    if (run === null) return skippedRun();
    return SyncEngine.execute(this.#syncTarget(), run, workspace, options, clock);
  }

  /**
   * The integration (or its workspace) is gone: nothing is synced. A run named by `runId` that is
   * still `queued` or `running` ends `failed` with `integration_deleted`, so it is never left open;
   * one left `running` by a crash may have revived rows after the disconnect deleted them, so they
   * are deleted again. Anything else is a no-op (`skipped`). `found` is the integration when it is
   * known (its workspace is the one gone); otherwise it is looked up, deleted ones included.
   */
  static async #endRunOfGone(
    integrationId: string,
    found: IntegrationData | null,
    options: SyncRunOptions,
    now: Date,
  ): Promise<SyncRunSummary> {
    if (options.runId === undefined) return skippedRun();
    const data =
      found ??
      (await (await getIntegrationRepository()).findIncludingDeletedForWorker(integrationId));
    if (data === null) return skippedRun();
    const run = await SyncRun.claim(data, options.runId);
    if (run === null) return skippedRun();
    const wasRunning = run.status === 'running';
    const error = SyncRun.error('integration_deleted');
    const counts = zeroCounts();
    if (!(await run.cancel(error, now, { counts: { ...counts }, failures: [] }))) {
      return skippedRun();
    }
    if (wasRunning) await SyncedRows.of(data).softDeleteAll(now);
    logger.info('sync run ended: the integration is gone', { runId: run.id, integrationId });
    return { runId: run.id, status: 'failed', counts, error };
  }

  /**
   * "Stop sharing" (PERMISSIONS-V2, share-on-attach): its owner takes it off every block of the
   * workspace, so its items are private to them again. Audited as `integration.stop_sharing`.
   */
  async stopSharing(caller: Caller): Promise<{ dashboards: number }> {
    this.assertOwner(caller);
    const dashboards = await Dashboard.removeConnectorEverywhere(caller, this);
    await AuditLog.record(caller, Integration.Audit.stopSharing, this, {
      provider: this.provider,
      dashboards,
    });
    return { dashboards };
  }

  /**
   * Its owner disconnects it (DATA.md §4, ruling 7), a template method:
   * 1. a grant the provider can take back (Revocable) goes back first, while the credential still
   *    opens (best effort: a failure is logged and never blocks the disconnect);
   * 2. the integration gets `deletedAt`: the dispatcher stops, the credential no longer opens, a
   *    sync run in flight sees the disconnect and deletes what it wrote since, and every block's
   *    connector to it stops reading (and sharing) anything; `integration.disconnect` is audited
   *    right after;
   * 3. the credential is hard-deleted, then checked gone (a survivor is a 500, loudly);
   * 4. its items and containers are soft-deleted (the purge job removes them 30 days later).
   * A disconnect that stopped part-way (a failure after step 1) resumes: on the soft-deleted
   * integration (findOwnIncludingDeleted) the steps run again (each is idempotent), without a
   * second audit entry.
   *
   * With `removeAdded` ("Also remove everything TodoList added"), an integration that can take it
   * back (AddedContentRemover: Google Calendar; 400 for any other) does so first, while it is
   * still connected and read & write (409 `integration_read_only` otherwise); a failure there
   * stops before anything is disconnected. Not for one already disconnected (409). Returns what
   * the clean-up did (its counts, `failed` and `skipped` included), or null without one.
   */
  async disconnect(
    caller: Caller,
    options: { removeAdded?: boolean } = {},
  ): Promise<AddedRemoval | null> {
    this.assertOwner(caller);
    let removed: AddedRemoval | null = null;
    if (options.removeAdded === true) {
      if (!isAddedContentRemover(this)) {
        throw new AppError(400, 'removeAdded: TodoList adds nothing at this provider');
      }
      if (this.isDeleted) {
        throw new AppError(
          409,
          'Already disconnected: what TodoList added can no longer be removed',
        );
      }
      removed = await this.removeAdded(caller);
    }
    await this.#disconnectSteps(caller);
    return removed;
  }

  async #disconnectSteps(by: AuditScope): Promise<void> {
    const { workspaceId, id } = this;
    const integrations = await getIntegrationRepository();
    if (!this.isDeleted && this.auth.kind === 'oauth' && isRevocable(this)) {
      await this.revokeGrant();
    }
    // False when another request deleted it meanwhile: that one audits, this one finishes the steps.
    if (!this.isDeleted && (await integrations.softDelete(workspaceId, id))) {
      await AuditLog.record(by, Integration.Audit.disconnect, this, { provider: this.provider });
    }
    await Credential.destroy(workspaceId, id);
    await SyncedRows.of(this).softDeleteAll();
  }

  // ─── The sessions (the only way to the credential) ───────────────────────

  /**
   * Runs `fn` with the credential opened for this one call: the secret and the provider headers
   * built from it, never a writer. What `fn` returns must not carry the secret (the credential
   * refuses it), and what it throws is redacted.
   */
  protected async withReadSession<T>(
    fn: (session: ReadSession<TSecret>) => Promise<T>,
  ): Promise<T> {
    return this.#credential.open((secret) =>
      fn({ secret, headers: this.auth.headers(secret, 'read') }),
    );
  }

  /**
   * The write gate: the only way to a provider writer. In order: the integration is the caller's
   * own (404); writes are on for it here (409 `provider_writes_off`: demo data, fixtures); it is
   * read & write (409 `integration_read_only`). Only then is the credential opened and the
   * writer made (`createWriter`, the provider's own).
   */
  protected async withWriteSession<T>(
    caller: Caller,
    fn: (session: WriteSession<TSecret, TWriter>) => Promise<T>,
  ): Promise<T> {
    this.assertWritable(caller);
    return this.#credential.open(async (secret) =>
      fn({
        secret,
        headers: this.auth.headers(secret, 'write'),
        writer: await this.createWriter(secret),
      }),
    );
  }

  /** The provider's writer over an opened secret: reached only through withWriteSession. */
  protected abstract createWriter(secret: TSecret): Promise<TWriter>;

  /** The connection test's provider call (the adapter's `test`): what the account says it is. */
  protected abstract probe(adapter: TestableAdapter, context: AdapterContext): Promise<unknown>;

  /**
   * What the provider is (its class's `static definition`): its strategies, config, rules and
   * fixtures. Null for a provider nobody connects (UnlistedIntegration).
   */
  protected get definition(): IntegrationDefinition<TSecret> | null {
    const defined = this.constructor as { readonly definition?: IntegrationDefinition<TSecret> };
    return defined.definition ?? null;
  }

  /**
   * The auth strategy of the stored `authMethod`, from the definition. A method this class does
   * not offer: no headers, its credential checked as that method (UnofferedAuth).
   */
  protected get auth(): AuthStrategy<TSecret> {
    const method = this.authMethod;
    return (
      this.definition?.authFor(method) ??
      new UnofferedAuth<TSecret>(method, strategyForMethod(method))
    );
  }

  /** The adapter of this provider (the sync's strategy object), or null when none is registered. */
  protected get adapter(): ProviderAdapter | null {
    return getAdapter(this.provider);
  }

  /** Whether this integration syncs from recorded fixtures (tests only; never an OAuth one). */
  protected get usesFixtures(): boolean {
    return syncModeFor(this.data) === 'fixtures';
  }

  /** 404 unless the caller is its owner, in its workspace (IntegrationPolicy). */
  protected assertOwner(caller: Caller): void {
    this.assertIn(caller);
    caller.authorize(IntegrationPolicy.instance, 'manage', this.data);
  }

  /**
   * Whether another live integration (in any workspace) uses the same OAuth account: revoking
   * its grant would end theirs too, so it is left in place.
   */
  protected async sharesGrant(): Promise<boolean> {
    const live = await (await getIntegrationRepository()).listActiveForDispatch();
    return live.some(
      (other) =>
        other.id !== this.id &&
        other.provider === this.provider &&
        other.accountId === this.accountId &&
        Integration.from(other).auth.kind === 'oauth',
    );
  }

  /**
   * Whether the stored grant lacks any of `scopes` (its credential's metadata: nothing is opened,
   * nothing is sent). None asked: false.
   */
  protected async lacksScopes(scopes: readonly string[]): Promise<boolean> {
    if (scopes.length === 0) return false;
    const meta = await Credential.meta(this.workspaceId, this.id);
    const granted = new Set(meta?.scopes ?? []);
    return scopes.some((scope) => !granted.has(scope));
  }

  /** The item fields an item of `kind` writes back to this provider (its definition's). */
  protected writableFieldsFor(kind: ItemKind): readonly WritableField[] {
    return this.definition?.writableFieldsFor(kind) ?? [];
  }

  /** The statuses a write-back can set at this provider (its definition's). */
  protected get reachableStatuses(): readonly ItemStatus[] {
    return this.definition?.reachableStatuses ?? [];
  }

  /**
   * Records a change made at the provider (`integration.write`): what kind of change and the
   * names of what it changed, never a value.
   */
  protected async recordWrite(caller: Caller, meta: Record<string, unknown>): Promise<void> {
    await AuditLog.record(caller, Integration.Audit.write, this, meta);
  }

  /**
   * A ResourcePicker's own checks: the integration is the caller's (404), and this connection
   * has something to pick (409: a token connection reads its one site or what its token reads).
   */
  protected assertPicks(caller: Caller, kind: PickerKind | null): void {
    this.assertOwner(caller);
    if (kind === null) {
      throw new AppError(
        409,
        `This ${this.provider} connection has nothing to pick: connect it with OAuth`,
      );
    }
  }

  /**
   * Hands the OAuth grant back to the provider (its strategy's revocation endpoint), best effort:
   * never throws (a failure is logged as `failure`). Left in place when another live integration
   * (in any workspace) uses the same account, whose grant revoking would end too. The Revocable
   * classes' revokeGrant.
   */
  protected async handBackGrant(failure: string): Promise<void> {
    const auth = this.auth;
    if (!(auth instanceof OAuthAuth) || auth.endpoints().revoke === null) return;
    try {
      if (await this.sharesGrant()) return;
      await this.withReadSession(async ({ secret }) => {
        await auth.revoke(secret);
      });
    } catch (error) {
      logger.warn(failure, {
        integrationId: this.id,
        errorName: error instanceof Error ? error.name : typeof error,
      });
    }
  }

  // ─── Hooks the provider classes override ─────────────────────────────────

  /**
   * Hands the OAuth grant back to the provider (a Revocable class: Google Calendar, Linear), best
   * effort: it never throws. The disconnect calls it before anything is deleted, whoever
   * disconnects (its owner, or whoever ended the owner's membership); `revoke(caller)` is the
   * same, for its owner. Nothing to hand back by default.
   */
  protected revokeGrant(): Promise<void> {
    return Promise.resolve();
  }

  /** Extra audit meta of a new integration, after what connecting it does (GitHub: a topic rule). */
  protected onConnected(): Promise<Record<string, unknown>> {
    return Promise.resolve({});
  }

  /** A config change, checked against what the grant covers (Jira sites, ClickUp workspaces). */
  protected checkSelection(config: Record<string, unknown>): Promise<Record<string, unknown>> {
    return Promise.resolve(config);
  }

  /** The label a successful test learns from the account's own (Jira, Moodle: with the site). */
  protected learnedLabel(accountLabel: string): string {
    return accountLabel;
  }

  /**
   * Settings a successful test learns from the capabilities the probe reports, by capability
   * (GitHub: `boards` → whether its token reads Projects boards). None by default.
   */
  protected readonly learnedCapabilities: Readonly<Record<string, LearnedSetting>> = {};

  // ─── What the collaborators get (protected members, handed over as functions) ──

  /** What "test connection" needs (ConnectionTester). */
  #testSubject(): TestSubject {
    return {
      data: this.toJSON(),
      adapter: this.adapter,
      usesFixtures: this.usesFixtures,
      defaultLabel: this.definition?.defaultLabel(this.toJSON().config) ?? null,
      learnedCapabilities: this.learnedCapabilities,
      learnedLabel: (accountLabel) => this.learnedLabel(accountLabel),
      hasCredential: () => this.hasCredential(),
      withSecret: (fn) => this.withReadSession(({ secret }) => fn(secret)),
      transport: (inner) => this.auth.transport(inner),
      auth: (secret, client, now) => this.auth.bind({ secret: secret as TSecret, client, now }),
      probe: (adapter, context) => this.probe(adapter, context),
    };
  }

  /** What "sync now" needs (SyncRequest). */
  #syncSubject(): SyncSubject {
    return {
      data: this.toJSON(),
      target: this,
      requestRun: async (caller): Promise<string> =>
        (await Integration.requestRun(this.id, 'manual', caller)).id,
      usesFixtures: this.usesFixtures,
      hasCredential: () => this.hasCredential(),
    };
  }

  /** What the sync engine needs (SyncEngine): its data and its own status writes. */
  #syncTarget(): SyncTarget {
    const { workspaceId, id } = this;
    return {
      data: this.toJSON(),
      reload: async (): Promise<IntegrationData | null> =>
        (await getIntegrationRepository()).findByIdForWorker(id),
      recordSyncResult: async (result): Promise<void> => {
        await (await getIntegrationRepository()).recordSyncResult(workspaceId, id, result);
      },
    };
  }

  /** Whether a credential is saved (its metadata: nothing is opened). */
  async hasCredential(): Promise<boolean> {
    return (await Credential.meta(this.workspaceId, this.id)) !== null;
  }
}
