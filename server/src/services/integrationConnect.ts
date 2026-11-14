/**
 * The ONE way an OAuth result becomes an integration (Google Calendar, GitHub, Jira, ClickUp,
 * Linear): create it for the provider account, or reconnect the one the member has, seal the
 * credential, clear the failures it left, and mark it active. Routes and provider code never
 * write integrations themselves, so the ownership rules (PERMISSIONS-V2) live here:
 * - an integration is its connecting member's (`ownerUserId`); a reconnect finds only the
 *   member's own integration of that account, and a reconnect started from an integration
 *   (`reconnectIntegrationId`) must be one of theirs: nobody reconnects another member's;
 * - another member's integration of the same account is left alone: each member gets their own
 *   (ruling 8);
 * - a new integration needs an editor or owner (ruling 9; a viewer may still reconnect their
 *   own, ruling 10) and room under both caps (ruling 19), which hold under concurrent connects
 *   (createWithinCaps).
 */
import type { IntegrationData } from '../models/definitions/Integration.js';
import { getIntegrationRepository, getSyncStateRepository } from '../models/index.js';
import { RUN_STATE_RESOURCE } from '../sync/runSync.js';
import type { IntegrationMode, Provider } from '../types/domain.js';
import type { WorkspaceContext } from './accessFilter.js';
import { storeCredential } from './crypto/credentialWriter.js';
import { AuditTarget } from '../classes/base/AuditTarget.js';
import { AuditLog } from '../classes/AuditLog.js';
import { Role } from '../classes/base/Role.js';
import { IntegrationPolicy } from '../classes/policies/IntegrationPolicy.js';
import {
  addOwnerTopicRule,
  createWithinCaps,
  CREDENTIAL_MISSING,
  isDuplicateKey,
  type IntegrationActor,
} from './integrations.js';
import { OAuthFailure } from './oauth/common.js';
import { topicIdBySlug } from './topics.js';

export interface OAuthConnection {
  provider: Provider;
  /** The provider's stable account key (Google `sub`, GitHub login, Atlassian account id…). */
  accountId: string;
  label: string;
  /** Non-secret settings a new integration starts with (a reconnect keeps what it has). */
  config: Record<string, unknown>;
  /** The default topic (by slug) a new integration starts in; Unsorted when the workspace has none. */
  topicSlug: string;
  mode: IntegrationMode;
  /** Sealed as is: write-only from here on. */
  secret: Record<string, string>;
  scopes: string[];
  /** GitHub: a user's own repositories are personal (the personal-topic rule). */
  githubLogin?: string | undefined;
  /** The integration a reconnect started from (the OAuth state's): it must be the member's own. */
  reconnectIntegrationId?: string | null | undefined;
}

export interface ConnectedIntegration {
  integration: IntegrationData;
  created: boolean;
}

function reconnectable(integration: IntegrationData): IntegrationData {
  if (integration.authMethod !== 'oauth') throw new OAuthFailure('oauth_failed');
  return integration;
}

/** createWithinCaps, as the OAuth callback answers a full cap: `oauth_limit`. */
async function createOrLimit(
  workspaceId: string,
  input: Parameters<typeof createWithinCaps>[1],
): Promise<{ created: IntegrationData }> {
  const result = await createWithinCaps(workspaceId, input);
  if (result.cap !== null) throw new OAuthFailure('oauth_limit');
  return { created: result.created };
}

/** The member's own integration for this account: reconnected, or created. */
async function upsertIntegration(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  conn: OAuthConnection,
): Promise<ConnectedIntegration> {
  const integrations = await getIntegrationRepository();
  if (conn.reconnectIntegrationId !== undefined && conn.reconnectIntegrationId !== null) {
    const target = await integrations.findById(ctx.id, conn.reconnectIntegrationId);
    if (target === null || !IntegrationPolicy.isOwn(target, actor.userId)) {
      throw new OAuthFailure('oauth_failed');
    }
  }
  const find = async (): Promise<IntegrationData | null> =>
    (await integrations.listForOwner(ctx.id, actor.userId)).find(
      (entry) => entry.provider === conn.provider && entry.accountId === conn.accountId,
    ) ?? null;
  const existing = await find();
  if (existing !== null) return { integration: reconnectable(existing), created: false };
  if (!Role.of(ctx.role).atLeast(Role.editor)) throw new OAuthFailure('oauth_not_editor');
  const topicId = await topicIdBySlug(ctx.id, conn.topicSlug);
  try {
    const { created } = await createOrLimit(ctx.id, {
      connectedBy: actor.userId,
      ownerUserId: actor.userId,
      provider: conn.provider,
      accountId: conn.accountId,
      label: conn.label,
      authMethod: 'oauth',
      topicId,
      mode: conn.mode,
      config: conn.config,
      status: 'error',
      lastError: { ...CREDENTIAL_MISSING },
    });
    const meta: Record<string, unknown> = { provider: conn.provider, topicId, authMethod: 'oauth' };
    if (conn.githubLogin !== undefined) {
      const topicRule = await addOwnerTopicRule(ctx.id, conn.githubLogin);
      if (topicRule !== null) meta['topicRule'] = topicRule;
    }
    await AuditLog.record(
      { workspaceId: ctx.id, actor },
      'integration.create',
      AuditTarget.integration(created.id),
      meta,
    );
    return { integration: created, created: true };
  } catch (error) {
    // The member connected the same account meanwhile (another tab): that one is reconnected.
    if (!isDuplicateKey(error)) throw error;
    const raced = await find();
    if (raced === null) throw error;
    return { integration: reconnectable(raced), created: false };
  }
}

/**
 * Connects (or reconnects) the account with its sealed credential, as the member's own. The
 * caller has checked that the grant is what the integration needs; the role and ownership rules
 * are checked here (upsertIntegration).
 */
export async function connectOAuthIntegration(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  conn: OAuthConnection,
): Promise<ConnectedIntegration> {
  const result = await upsertIntegration(ctx, actor, conn);
  const { integration } = result;
  await storeCredential(
    {
      workspaceId: ctx.id,
      integrationId: integration.id,
      provider: conn.provider,
      ownerUserId: actor.userId,
      kind: 'oauth',
      scopes: conn.scopes,
      secret: conn.secret,
    },
    actor,
  );
  // Connected (again): failed runs start from 0, the account's name is its label.
  await (
    await getSyncStateRepository()
  ).upsert(ctx.id, integration.id, RUN_STATE_RESOURCE, { consecutiveErrors: 0 });
  const updated = await (
    await getIntegrationRepository()
  ).update(ctx.id, integration.id, {
    status: 'active',
    lastError: null,
    expiresAt: null,
    label: conn.label,
  });
  return { integration: updated ?? integration, created: result.created };
}
