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
 */
import type { ActorRef } from '../base/Actor.js';
import { AuditTarget } from '../base/AuditTarget.js';
import type { Caller } from '../base/Caller.js';
import type { Auditable, Owned, SoftDeletable, Viewable } from '../base/contracts.js';
import { WorkspaceEntity } from '../base/WorkspaceEntity.js';
import { AuditLog, type AuditScope } from '../AuditLog.js';
import { IntegrationPolicy } from '../policies/IntegrationPolicy.js';
import { ItemPolicy } from '../policies/ItemPolicy.js';
import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import { NotFoundError } from '../../errors/NotFoundError.js';
import { ReadOnlyIntegrationError } from '../../errors/ReadOnlyIntegrationError.js';
import { ValidationError } from '../../errors/ValidationError.js';
import type { ErrorInfo } from '../../models/definitions/common.js';
import {
  toIntegrationStatus,
  type ConnectionTestPatch,
  type CreateIntegrationInput,
  type IntegrationData,
  type IntegrationPatch,
  type IntegrationStatusView,
} from '../../models/definitions/Integration.js';
import {
  getContainerRepository,
  getIntegrationRepository,
  getItemRepository,
  getSyncRunRepository,
  getSyncStateRepository,
} from '../../models/index.js';
import { removeConnectorEverywhere } from '../../services/dashboards.js';
import { assertUserConnectable, EMPTY_UPDATE_MESSAGE } from '../../services/integrationConfig.js';
import { logger } from '../../services/logger.js';
import { OAuthFailure } from '../../services/oauth/common.js';
import { writeModeFor } from '../../services/providerCreate/mode.js';
import { enqueueSync } from '../../services/syncJobs.js';
import { assertTopicOf, topicIdBySlug } from '../../services/topics.js';
import { ProviderHttpError } from '../../sync/errors.js';
import { fixtureSetDir } from '../../sync/fixtureSets.js';
import type { Transport } from '../../sync/http.js';
import '../../sync/providers/index.js';
import { getAdapter } from '../../sync/registry.js';
import { RUN_STATE_RESOURCE, SYNC_ERROR_MESSAGES } from '../../sync/runSync.js';
import { syncModeFor } from '../../sync/syncMode.js';
import { fixtureTransport, loadFixtureSet } from '../../sync/transports/fixtures.js';
import type { AdapterContext, ProviderAdapter } from '../../sync/types.js';
import {
  PROVIDERS,
  type AuthMethod,
  type IntegrationMode,
  type Provider,
} from '../../types/domain.js';
import type { IntegrationTestResult, ProviderCapabilities } from '../../types/integrations.js';
import type { AuthKind, AuthStrategy, SecretJson } from './auth/AuthStrategy.js';
import { OAuthAuth } from './auth/OAuthAuth.js';
import { UnofferedAuth } from './auth/UnofferedAuth.js';
import { isCreateFunnel, isResourcePicker, isRevocable } from './capabilities.js';
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
  type TestRateLimited,
} from './connectionTest.js';
import { Credential } from './Credential.js';
import { isPlaceholderAccountId } from './definitions/fields.js';
import {
  DEFINITIONS,
  requireDefinition,
  strategyForMethod,
  type ConnectionInput,
  type IntegrationDefinition,
} from './definitions/index.js';
import { IntegrationRegistry } from './IntegrationRegistry.js';
import { Mode } from './Mode.js';

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

/** An OAuth result, as the flow hands it over: the account, its grant and where it starts. */
export interface OAuthConnection {
  provider: Provider;
  /** The provider's stable account key (Google `sub`, GitHub login, Atlassian account id…). */
  accountId: string;
  label: string;
  /** Non-secret settings a new integration starts with (a reconnect keeps what it has). */
  config: Record<string, unknown>;
  /** The default topic (by slug) a new integration starts in; Unsorted when the workspace has none. */
  topicSlug: string;
  /** Sealed as is: write-only from here on. */
  secret: Record<string, string>;
  scopes: string[];
  /** The integration a reconnect started from (the OAuth state's): it must be the member's own. */
  reconnectIntegrationId?: string | null | undefined;
}

export interface ConnectedIntegration {
  integration: Integration;
  created: boolean;
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

/** Why a new integration is `error`: until `PUT …/credential`, it has no credential (R5). */
export const CREDENTIAL_MISSING = {
  code: 'credential_missing',
  message: 'Save the credential to finish connecting',
} as const;

/** MongoDB's E11000: here, an account already connected in the workspace. */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

type IntegrationCap = 'member' | 'workspace';

/** A setting a successful connection test may learn (ConnectionTestPatch, the label aside). */
type LearnedSetting = Exclude<keyof ConnectionTestPatch, 'label'>;

/** A connect within the caps: the new integration, or which cap was full. */
type WithinCaps = { created: IntegrationData; cap: null } | { created: null; cap: IntegrationCap };

/** Why an integration can't be synced now. */
type SyncHold = 'demo' | 'paused' | 'expired' | 'reconnect' | 'no_credential';

const HOLD_MESSAGES: Readonly<Record<SyncHold, string>> = {
  demo: 'Demo data never syncs: its items are a sample',
  paused: 'This integration is paused: save its credential again to resume',
  expired: 'This connection has expired: save a new credential',
  reconnect: 'Reconnect required: save the credential again',
  no_credential: 'Save the credential first',
};

/** Runs looked at for the newest manual one: far more than 5 minutes can hold. */
const RECENT_RUNS = 20;
const RATE_WINDOW_MS = 60_000;
/** Tests audited in one workspace in a minute: at most 5 per integration, 20 integrations. */
const RECENT_TESTS_SCANNED = 200;
const NO_SECRET: SecretJson = Object.freeze({});

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
   * The sync engine's read session (sync/secrets.ts, until the engine moves behind the class):
   * the integration's opened secret for `fn`, never a writer. 404 when it is missing or deleted.
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
   * definition (auth methods, picker, revoke page, coming soon) and the contracts its class
   * implements (ResourcePicker, Revocable, CreateFunnel). In the order of CONNECTABLE_PROVIDERS.
   */
  static capabilitiesOf(): ProviderCapabilities[] {
    return DEFINITIONS.flatMap((definition) => {
      const cls = IntegrationRegistry.instance.classOf(definition.provider);
      if (cls === null) return [];
      const can = cls.prototype;
      return [
        {
          provider: definition.provider,
          authMethods: definition.userAuthMethods,
          picker: isResourcePicker(can) ? definition.picker : null,
          revokesOnDisconnect: isRevocable(can),
          revokePage: definition.revokePage,
          canCreate: isCreateFunnel(can) && definition.create !== null,
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

  /**
   * Which cap (ruling 19) is exceeded with `extra` more integrations of the member's:
   * LIMITS.integrationsPerUserPerWorkspace of their own, LIMITS.integrationsPerWorkspace for every
   * member together. Null when both hold.
   */
  static async #capExceeded(
    workspaceId: string,
    ownerUserId: string,
    extra: number,
  ): Promise<IntegrationCap | null> {
    const integrations = await getIntegrationRepository();
    if (
      (await integrations.countActiveForOwner(workspaceId, ownerUserId)) + extra >
      LIMITS.integrationsPerUserPerWorkspace
    ) {
      return 'member';
    }
    if ((await integrations.countActive(workspaceId)) + extra > LIMITS.integrationsPerWorkspace) {
      return 'workspace';
    }
    return null;
  }

  /**
   * A new integration, inserted only within both caps even when connects race (there are no
   * transactions here): check, insert, then count again with the new one included. Over a cap,
   * the new integration is soft-deleted again and the full cap comes back instead. Racers may all
   * back out, but the caps are never exceeded: the last of any set of kept integrations to count
   * would have seen them all. The insert's own errors (a duplicate account) propagate. Every new
   * integration is read-only: `mode` is never an input.
   */
  static async #createWithinCaps(
    workspaceId: string,
    input: Omit<CreateIntegrationInput, 'mode'> & { ownerUserId: string },
  ): Promise<WithinCaps> {
    const full = await Integration.#capExceeded(workspaceId, input.ownerUserId, 1);
    if (full !== null) return { created: null, cap: full };
    const integrations = await getIntegrationRepository();
    const created = await integrations.create(workspaceId, { ...input, mode: Mode.read.name });
    const exceeded = await Integration.#capExceeded(workspaceId, input.ownerUserId, 0);
    if (exceeded === null) return { created, cap: null };
    await integrations.softDelete(workspaceId, created.id);
    return { created: null, cap: exceeded };
  }

  /**
   * Editors and owners: a new integration of their own from the provider and its non-secret
   * config (validated per provider, integrationConfig.ts), connected with a key or token. It has
   * no credential yet, so it starts as `error` with `lastError` CREDENTIAL_MISSING (the API shows
   * `error`) until `PUT …/credential` saves one. It is read-only. 409 at either cap (they hold
   * under concurrent connects) and for an account this member already connected here (another
   * member may connect the same account: ruling 8). Audited as `integration.create`.
   */
  static async connectWithKey(
    caller: Caller,
    input: ConnectionInput,
    options: { demo?: boolean } = {},
  ): Promise<Integration> {
    // Requests route through requireWorkspace(minRole) too; the class checks again for MCP.
    caller.require('editor');
    const workspaceId = caller.workspaceId;
    if (options.demo !== true) assertUserConnectable(input.provider);
    const plan = requireDefinition(input.provider).planConnection(input);
    if (plan.topicId !== undefined && plan.topicId !== null) {
      await assertTopicOf(workspaceId, plan.topicId);
    }
    const topicId =
      plan.topicId === undefined
        ? await topicIdBySlug(workspaceId, plan.defaultTopic)
        : plan.topicId;
    let result: WithinCaps;
    try {
      result = await Integration.#createWithinCaps(workspaceId, {
        connectedBy: caller.userId,
        ownerUserId: caller.userId,
        provider: plan.provider,
        accountId: plan.accountId,
        label: plan.label,
        authMethod: plan.authMethod,
        topicId,
        config: plan.config,
        status: 'error',
        lastError: { ...CREDENTIAL_MISSING },
        ...(options.demo === true ? { demo: true } : {}),
      });
    } catch (error) {
      if (isDuplicateKey(error)) {
        throw new AppError(
          409,
          `You already connected this ${plan.provider} account (${plan.label}) in this workspace`,
          { code: 'account_already_connected' },
        );
      }
      throw error;
    }
    if (result.cap !== null) {
      throw new AppError(
        409,
        result.cap === 'member'
          ? `You can connect at most ${String(LIMITS.integrationsPerUserPerWorkspace)} integrations in a workspace`
          : `A workspace can have at most ${String(LIMITS.integrationsPerWorkspace)} integrations`,
      );
    }
    const created = Integration.from(result.created);
    const meta: Record<string, unknown> = {
      provider: plan.provider,
      topicId,
      authMethod: plan.authMethod,
      ...(await created.onConnected()),
    };
    await AuditLog.record(caller, Integration.Audit.create, created, meta);
    return created;
  }

  /**
   * The ONE way an OAuth result becomes an integration (Google Calendar, GitHub, Jira, ClickUp,
   * Linear): create it for the provider account, or reconnect the one the member has, seal the
   * credential, clear the failures it left, and mark it active. The ownership rules:
   * - an integration is its connecting member's; a reconnect finds only the member's own
   *   integration of that account, and a reconnect started from an integration must be theirs;
   * - another member's integration of the same account is left alone (ruling 8);
   * - a new integration needs an editor or owner (ruling 9; a viewer may still reconnect their
   *   own, ruling 10) and room under both caps (ruling 19). It is read-only.
   * The caller has checked that the grant is what the integration needs.
   */
  static async connectOAuth(caller: Caller, conn: OAuthConnection): Promise<ConnectedIntegration> {
    const result = await Integration.#upsertOAuth(caller, conn);
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
    await (
      await getSyncStateRepository()
    ).upsert(workspaceId, integration.id, RUN_STATE_RESOURCE, { consecutiveErrors: 0 });
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

  /** The member's own integration for this account: reconnected, or created. */
  static async #upsertOAuth(caller: Caller, conn: OAuthConnection): Promise<ConnectedIntegration> {
    const workspaceId = caller.workspaceId;
    const integrations = await getIntegrationRepository();
    if (conn.reconnectIntegrationId !== undefined && conn.reconnectIntegrationId !== null) {
      const target = await integrations.findById(workspaceId, conn.reconnectIntegrationId);
      if (target === null || !IntegrationPolicy.isOwn(target, caller.userId)) {
        throw new OAuthFailure('oauth_failed');
      }
    }
    const reconnectable = (data: IntegrationData): ConnectedIntegration => {
      const integration = Integration.from(data);
      if (integration.auth.kind !== 'oauth') throw new OAuthFailure('oauth_failed');
      return { integration, created: false };
    };
    const find = async (): Promise<IntegrationData | null> =>
      (await integrations.listForOwner(workspaceId, caller.userId)).find(
        (entry) => entry.provider === conn.provider && entry.accountId === conn.accountId,
      ) ?? null;
    const existing = await find();
    if (existing !== null) return reconnectable(existing);
    if (!caller.role.atLeast('editor')) throw new OAuthFailure('oauth_not_editor');
    const topicId = await topicIdBySlug(workspaceId, conn.topicSlug);
    try {
      const result = await Integration.#createWithinCaps(workspaceId, {
        connectedBy: caller.userId,
        ownerUserId: caller.userId,
        provider: conn.provider,
        accountId: conn.accountId,
        label: conn.label,
        authMethod: 'oauth',
        topicId,
        config: conn.config,
        status: 'error',
        lastError: { ...CREDENTIAL_MISSING },
      });
      // createWithinCaps, as the OAuth callback answers a full cap: `oauth_limit`.
      if (result.cap !== null) throw new OAuthFailure('oauth_limit');
      const created = Integration.from(result.created);
      const meta: Record<string, unknown> = {
        provider: conn.provider,
        topicId,
        authMethod: 'oauth',
        ...(await created.onConnected()),
      };
      await AuditLog.record(caller, Integration.Audit.create, created, meta);
      return { integration: created, created: true };
    } catch (error) {
      // The member connected the same account meanwhile (another tab): that one is reconnected.
      if (!isDuplicateKey(error)) throw error;
      const raced = await find();
      if (raced === null) throw error;
      return reconnectable(raced);
    }
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

  /** Does this OAuth grant lack the scope that creates items (Jira, Linear)? */
  async needsWriteConsent(): Promise<boolean> {
    const auth = this.auth;
    if (!(auth instanceof OAuthAuth)) return false;
    const needed = auth.writeScopes;
    if (needed.length === 0) return false;
    const meta = await Credential.meta(this.workspaceId, this.id);
    const granted = new Set(meta?.scopes ?? []);
    return needed.some((scope) => !granted.has(scope));
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
      if (input.topicId !== null) await assertTopicOf(this.workspaceId, input.topicId);
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
    await (
      await getSyncStateRepository()
    ).upsert(workspaceId, id, RUN_STATE_RESOURCE, { consecutiveErrors: 0 });
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
    const wait = await this.#waitBeforeNextTest();
    if (wait > 0) return { retryAfterMs: wait };
    const outcome = await this.#runTest(caller.settings.timezone);
    let result: IntegrationTestResult;
    if ('probe' in outcome) {
      result = await this.#recordSuccess(outcome.probe);
    } else {
      logFailure(this.data, outcome.code, outcome.error);
      if (outcome.code === 'auth_failed') {
        // A reconnect is needed. A pause or an expiry is kept (the conditional write).
        await (
          await getIntegrationRepository()
        ).recordSyncResult(this.workspaceId, this.id, {
          status: 'error',
          lastError: { code: 'auth_failed', message: SYNC_ERROR_MESSAGES.auth_failed },
        });
      }
      result = { ok: false, code: outcome.code };
    }
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
    const hold = await this.#syncHold();
    if (hold !== null) throw new AppError(409, HOLD_MESSAGES[hold]);
    const wait = await this.#manualSyncWait();
    if (wait > 0) return { retryAfterMs: wait };
    return { runId: await this.#enqueueManualSync() };
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
      if ((await integration.#syncHold()) !== null) continue;
      if ((await integration.#manualSyncWait()) > 0) continue;
      try {
        runIds.push(await integration.#enqueueManualSync());
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

  /**
   * "Stop sharing" (PERMISSIONS-V2, share-on-attach): its owner takes it off every block of the
   * workspace, so its items are private to them again. Audited as `integration.stop_sharing`.
   */
  async stopSharing(caller: Caller): Promise<{ dashboards: number }> {
    this.assertOwner(caller);
    const dashboards = await removeConnectorEverywhere(caller.context, caller.actor, this.id);
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
   */
  async disconnect(caller: Caller): Promise<void> {
    this.assertOwner(caller);
    await this.#disconnectSteps(caller);
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
    await (await getItemRepository()).softDeleteForIntegration(workspaceId, id);
    await (await getContainerRepository()).softDeleteForIntegration(workspaceId, id);
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

  // ─── Internals ───────────────────────────────────────────────────────────

  async #runTest(timeZone: string): Promise<Outcome> {
    const adapter = this.adapter;
    if (adapter === null) return { code: 'no_adapter' };
    if (!canTest(adapter)) return { code: 'not_supported' };
    const deadline = Date.now() + CONNECTION_TEST_TIMEOUT_MS;

    if (this.usesFixtures) {
      let transport: Transport;
      try {
        transport = fixtureTransport(await loadFixtureSet(fixtureSetDir(adapter)));
      } catch (error) {
        return { code: 'fixtures_missing', error };
      }
      try {
        return {
          probe: await this.#probeWith(
            adapter,
            timeZone,
            NO_SECRET as TSecret,
            transport,
            deadline,
          ),
        };
      } catch (error) {
        return failed(error);
      }
    }

    const credential = await Credential.meta(this.workspaceId, this.id);
    if (credential === null) return { code: 'credential_missing' };
    // An object, so the callback's write is seen after the await (a flag would stay narrowed).
    const progress = { opened: false };
    try {
      const found = await this.withReadSession((session) => {
        progress.opened = true;
        const transport = this.auth.transport(connectionTestTransport());
        return this.#probeWith(adapter, timeZone, session.secret, transport, deadline);
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
    secret: TSecret,
    transport: Transport,
    deadline: number,
  ): Promise<Probe> {
    const client = adapter.createClient(testTransport(transport, deadline), NO_WAIT);
    const now = new Date();
    const context: AdapterContext = {
      integration: this.toJSON(),
      secret,
      // The headers come from the integration's auth strategy, never from the adapter.
      auth: this.auth.bind({ secret, client, now }),
      client,
      now,
      timeZone,
      fullSyncDue: false,
    };
    return toProbe(await beforeDeadline(this.probe(adapter, context), deadline));
  }

  /**
   * A pending account becomes the real one (once); a default label becomes the account's own;
   * what the provider class learns from the probe is recorded. The label and the settings are
   * written field by field (recordConnectionTest), so a label or config saved while the test ran
   * is kept.
   */
  async #recordSuccess(found: Probe): Promise<IntegrationTestResult> {
    const integrations = await getIntegrationRepository();
    if (isPlaceholderAccountId(this.accountId)) {
      try {
        await integrations.replacePendingAccount(
          this.workspaceId,
          this.id,
          found.accountId ?? found.accountLabel,
        );
      } catch (error) {
        if (isDuplicateKey(error)) return { ok: false, code: 'already_connected' };
        throw error;
      }
    }
    const learned: ConnectionTestPatch = {};
    const definition = this.definition;
    if (definition !== null) {
      const label = definition.defaultLabel(this.toJSON().config);
      if (this.label === label && found.accountLabel !== label) {
        learned.label = { from: label, to: this.learnedLabel(found.accountLabel) };
      }
    }
    for (const [capability, setting] of Object.entries(this.learnedCapabilities)) {
      const value = found.capabilities?.[capability];
      if (value !== undefined) learned[setting] = value;
    }
    if (learned.label !== undefined || learned.boardsEnabled !== undefined) {
      await integrations.recordConnectionTest(this.workspaceId, this.id, learned);
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
  async #waitBeforeNextTest(): Promise<number> {
    const now = Date.now();
    const entries = await AuditLog.list(
      this.workspaceId,
      { action: Integration.Audit.test, since: new Date(now - RATE_WINDOW_MS) },
      RECENT_TESTS_SCANNED,
    );
    // Newest first: the last one that still counts against the limit.
    const counted = entries.filter((entry) => entry.targetId === this.id);
    const oldest = counted[LIMITS.connectionTestsPerMinute - 1];
    if (oldest === undefined) return 0;
    return Math.max(1, oldest.at.getTime() + RATE_WINDOW_MS - now);
  }

  /** What waits for the owner, as the dispatcher sees it; live mode also needs a credential. */
  async #syncHold(): Promise<SyncHold | null> {
    if (this.demo) return 'demo';
    if (this.status === 'paused') return 'paused';
    if (this.status === 'expired') return 'expired';
    if (this.lastError?.code === 'auth_failed') return 'reconnect';
    if (!this.usesFixtures) {
      if ((await Credential.meta(this.workspaceId, this.id)) === null) return 'no_credential';
    }
    return null;
  }

  /** How long until the integration may be synced manually again (0: now). */
  async #manualSyncWait(): Promise<number> {
    const runs = await (
      await getSyncRunRepository()
    ).listForIntegration(this.workspaceId, this.id, RECENT_RUNS);
    const newestManual = runs
      .filter((run) => run.trigger === 'manual')
      .reduce<number>((newest, run) => Math.max(newest, run.createdAt.getTime()), 0);
    if (newestManual === 0) return 0;
    return Math.max(0, newestManual + LIMITS.manualSyncIntervalMs - Date.now());
  }

  /**
   * A failure to start the run (on Lambda, the async invoke of the function itself) is not the
   * request's: 503, the detail in the log.
   */
  async #enqueueManualSync(): Promise<string> {
    try {
      return (await enqueueSync(this.id, 'manual')).runId;
    } catch (error) {
      logger.error('could not queue a manual sync', { integrationId: this.id, error });
      throw new AppError(503, 'Could not queue the sync. Try again later.');
    }
  }
}
