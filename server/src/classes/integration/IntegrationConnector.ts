/**
 * How a new integration comes to be (Integration's collaborator: Integration.connectWithKey and
 * Integration.connectOAuth are the public doors). Editors and owners connect their own (ruling 9),
 * within the member's and the workspace's caps (ruling 19), which hold even when connects race;
 * every new integration is read-only (the mode is never an input). A new integration is audited
 * as `integration.create`, with what its class did on connecting (`onConnected`).
 */
import type { Caller } from '../base/Caller.js';
import { AuditLog } from '../AuditLog.js';
import { IntegrationPolicy } from '../policies/IntegrationPolicy.js';
import { LIMITS } from '../../config/limits.js';
import { AppError } from '../../errors/AppError.js';
import type {
  CreateIntegrationInput,
  IntegrationData,
} from '../../models/definitions/Integration.js';
import { getIntegrationRepository } from '../../models/index.js';
import { assertUserConnectable } from '../../services/integrationConfig.js';
import { OAuthFailure } from '../../services/oauth/failure.js';
import { assertTopicOf, topicIdBySlug } from '../../services/topics.js';
import type { Provider } from '../../types/domain.js';
import { requireDefinition, type ConnectionInput } from './definitions/index.js';
import type { Integration } from './Integration.js';
import { Mode } from './Mode.js';

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

/** Why a new integration is `error`: until `PUT …/credential`, it has no credential (R5). */
export const CREDENTIAL_MISSING = {
  code: 'credential_missing',
  message: 'Save the credential to finish connecting',
} as const;

/**
 * What connecting needs from the integration classes: their factory, the hook a new integration
 * runs (a protected member of Integration, handed over as a function), and the audit action.
 */
export interface ConnectorPort {
  from(data: IntegrationData): Integration;
  onConnected(integration: Integration): Promise<Record<string, unknown>>;
  readonly createdAction: string;
}

type IntegrationCap = 'member' | 'workspace';

/** A connect within the caps: the new integration, or which cap was full. */
type WithinCaps = { created: IntegrationData; cap: null } | { created: null; cap: IntegrationCap };

/** MongoDB's E11000: here, an account already connected in the workspace. */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

export class IntegrationConnector {
  readonly #port: ConnectorPort;

  constructor(port: ConnectorPort) {
    this.#port = port;
  }

  /**
   * Editors and owners: a new integration of their own from the provider and its non-secret
   * config (validated by its definition), connected with a key or token. It has no credential
   * yet, so it starts as `error` with `lastError` CREDENTIAL_MISSING (the API shows `error`) until
   * `PUT …/credential` saves one. It is read-only. 409 at either cap (they hold under concurrent
   * connects) and for an account this member already connected here (another member may connect
   * the same account: ruling 8). Audited as `integration.create`.
   */
  async connectWithKey(
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
      result = await IntegrationConnector.#createWithinCaps(workspaceId, {
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
    return this.#created(caller, result.created, {
      provider: plan.provider,
      topicId,
      authMethod: plan.authMethod,
    });
  }

  /**
   * The member's own integration for an OAuth account: reconnected, or created. The ownership
   * rules: a reconnect finds only the member's own integration of that account, and a reconnect
   * started from an integration must be theirs; another member's integration of the same account
   * is left alone (ruling 8); a new one needs an editor or owner (ruling 9; a viewer may still
   * reconnect their own, ruling 10) and room under both caps (`oauth_limit`).
   */
  async upsertOAuth(caller: Caller, conn: OAuthConnection): Promise<ConnectedIntegration> {
    const workspaceId = caller.workspaceId;
    const integrations = await getIntegrationRepository();
    if (conn.reconnectIntegrationId !== undefined && conn.reconnectIntegrationId !== null) {
      const target = await integrations.findById(workspaceId, conn.reconnectIntegrationId);
      if (target === null || !IntegrationPolicy.isOwn(target, caller.userId)) {
        throw new OAuthFailure('oauth_failed');
      }
    }
    const reconnectable = (data: IntegrationData): ConnectedIntegration => {
      const integration = this.#port.from(data);
      if (integration.authKind !== 'oauth') throw new OAuthFailure('oauth_failed');
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
      const result = await IntegrationConnector.#createWithinCaps(workspaceId, {
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
      const integration = await this.#created(caller, result.created, {
        provider: conn.provider,
        topicId,
        authMethod: 'oauth',
      });
      return { integration, created: true };
    } catch (error) {
      // The member connected the same account meanwhile (another tab): that one is reconnected.
      if (!isDuplicateKey(error)) throw error;
      const raced = await find();
      if (raced === null) throw error;
      return reconnectable(raced);
    }
  }

  /** The new integration's class runs its connect hook, and the create is audited. */
  async #created(
    caller: Caller,
    data: IntegrationData,
    meta: Record<string, unknown>,
  ): Promise<Integration> {
    const created = this.#port.from(data);
    await AuditLog.record(caller, this.#port.createdAction, created, {
      ...meta,
      ...(await this.#port.onConnected(created)),
    });
    return created;
  }

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
    const full = await IntegrationConnector.#capExceeded(workspaceId, input.ownerUserId, 1);
    if (full !== null) return { created: null, cap: full };
    const integrations = await getIntegrationRepository();
    const created = await integrations.create(workspaceId, { ...input, mode: Mode.read.name });
    const exceeded = await IntegrationConnector.#capExceeded(workspaceId, input.ownerUserId, 0);
    if (exceeded === null) return { created, cap: null };
    await integrations.softDelete(workspaceId, created.id);
    return { created: null, cap: exceeded };
  }
}
