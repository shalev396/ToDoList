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
import { Topic } from '../workspace/Topic.js';
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
type WithinCaps =
  | { created: IntegrationData[]; cap: null }
  | { created: null; cap: IntegrationCap };

/** MongoDB's E11000: here, an account already connected in the workspace. */
function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

/**
 * Which input a duplicate account refused (E11000): the first one a batch write refused (its
 * write error's index; 0 for a single insert), or null for any other error.
 */
function duplicateIndex(error: unknown): number | null {
  const { writeErrors } = (error ?? {}) as { writeErrors?: unknown };
  const first: unknown = Array.isArray(writeErrors) ? writeErrors[0] : writeErrors;
  if (!isDuplicateKey(error) && !isDuplicateKey(first)) return null;
  const { index } = (first ?? {}) as { index?: unknown };
  return typeof index === 'number' ? index : 0;
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
    const [created] = await this.connectAllWithKey(caller, [input], options);
    if (created === undefined) throw new Error('IntegrationConnector: nothing was connected');
    return created;
  }

  /**
   * `connectWithKey` for several connections at once, in a handful of round trips whatever their
   * number (the demo seed's): the topics read once, both caps checked for all of them (before and
   * after, as one connect is), the integrations inserted in one write in the order given (each a
   * millisecond after the one before it, so they list in that order), each class's connect hook in
   * that order, then the audit entries in one write. A duplicate account stops it at that one
   * (409); the ones before it stay connected, as one connect after another would leave them.
   */
  async connectAllWithKey(
    caller: Caller,
    inputs: readonly ConnectionInput[],
    options: { demo?: boolean } = {},
  ): Promise<Integration[]> {
    // Requests route through requireWorkspace(minRole) too; the class checks again for MCP.
    caller.require('editor');
    const workspaceId = caller.workspaceId;
    const plans = inputs.map((input) => {
      if (options.demo !== true) assertUserConnectable(input.provider);
      return requireDefinition(input.provider).planConnection(input);
    });
    if (plans.length === 0) return [];
    await Topic.assertAllOf(workspaceId, [
      ...new Set(plans.flatMap(({ topicId }) => topicId ?? [])),
    ]);
    const bySlug = plans.some(({ topicId }) => topicId === undefined)
      ? new Map((await Topic.list(workspaceId)).map((topic) => [topic.slug, topic.id]))
      : new Map<string, string>();
    const planned = plans.map((plan) => ({
      plan,
      topicId: plan.topicId === undefined ? (bySlug.get(plan.defaultTopic) ?? null) : plan.topicId,
    }));
    let result: WithinCaps;
    try {
      result = await IntegrationConnector.#createWithinCaps(
        workspaceId,
        caller.userId,
        planned.map(({ plan, topicId }) => ({
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
        })),
      );
    } catch (error) {
      const duplicate = duplicateIndex(error);
      const plan = duplicate === null ? undefined : planned[duplicate]?.plan;
      if (plan !== undefined) {
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
    return this.#createdAll(
      caller,
      result.created.map((data, index) => {
        const entry = planned[index];
        if (entry === undefined) throw new Error('IntegrationConnector: a connection is missing');
        const { plan, topicId } = entry;
        return { data, meta: { provider: plan.provider, topicId, authMethod: plan.authMethod } };
      }),
    );
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
    const topicId = (await Topic.bySlug(workspaceId, conn.topicSlug))?.id ?? null;
    try {
      const result = await IntegrationConnector.#createWithinCaps(workspaceId, caller.userId, [
        {
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
        },
      ]);
      // createWithinCaps, as the OAuth callback answers a full cap: `oauth_limit`.
      if (result.cap !== null) throw new OAuthFailure('oauth_limit');
      const [data] = result.created;
      if (data === undefined) throw new Error('IntegrationConnector: nothing was created');
      const integration = await this.#created(caller, data, {
        provider: conn.provider,
        topicId,
        authMethod: 'oauth',
      });
      return { integration, created: true };
    } catch (error) {
      // The member connected the same account meanwhile (another tab): that one is reconnected.
      if (duplicateIndex(error) === null) throw error;
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
    const [created] = await this.#createdAll(caller, [{ data, meta }]);
    if (created === undefined) throw new Error('IntegrationConnector: nothing was created');
    return created;
  }

  /**
   * Each new integration's class runs its connect hook, in order; then every create is audited,
   * in one write.
   */
  async #createdAll(
    caller: Caller,
    created: readonly { data: IntegrationData; meta: Record<string, unknown> }[],
  ): Promise<Integration[]> {
    const connected: { integration: Integration; meta: Record<string, unknown> }[] = [];
    for (const { data, meta } of created) {
      const integration = this.#port.from(data);
      connected.push({
        integration,
        meta: { ...meta, ...(await this.#port.onConnected(integration)) },
      });
    }
    await AuditLog.recordAll(
      caller,
      connected.map(({ integration, meta }) => ({
        action: this.#port.createdAction,
        target: integration,
        meta,
      })),
    );
    return connected.map(({ integration }) => integration);
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
    // Both counts at once; the member's cap is answered first.
    const [own, all] = await Promise.all([
      integrations.countActiveForOwner(workspaceId, ownerUserId),
      integrations.countActive(workspaceId),
    ]);
    if (own + extra > LIMITS.integrationsPerUserPerWorkspace) return 'member';
    if (all + extra > LIMITS.integrationsPerWorkspace) return 'workspace';
    return null;
  }

  /**
   * New integrations of one member, inserted only within both caps even when connects race
   * (there are no transactions here): check with all of them, insert them, then count again with
   * them included. Over a cap, the new ones are soft-deleted again and the full cap comes back
   * instead. Racers may all back out, but the caps are never exceeded: the last of any set of kept
   * integrations to count would have seen them all. The insert's own errors (a duplicate account)
   * propagate. Every new integration is read-only: `mode` is never an input.
   */
  static async #createWithinCaps(
    workspaceId: string,
    ownerUserId: string,
    inputs: readonly Omit<CreateIntegrationInput, 'mode'>[],
  ): Promise<WithinCaps> {
    const full = await IntegrationConnector.#capExceeded(workspaceId, ownerUserId, inputs.length);
    if (full !== null) return { created: null, cap: full };
    const integrations = await getIntegrationRepository();
    const created = await integrations.createMany(
      workspaceId,
      inputs.map((input) => ({ ...input, mode: Mode.read.name })),
    );
    const exceeded = await IntegrationConnector.#capExceeded(workspaceId, ownerUserId, 0);
    if (exceeded === null) return { created, cap: null };
    for (const integration of created) await integrations.softDelete(workspaceId, integration.id);
    return { created: null, cap: exceeded };
  }
}
