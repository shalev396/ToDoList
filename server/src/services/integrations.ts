/**
 * Integrations (DATA.md §3.4, §4, §5; BACKEND.md §4): connect, list, edit, disconnect. The
 * credential is integrationCredentials.ts and "test connection" is integrationTest.ts.
 *
 * Pure services: no Express types. Callers pass the caller's WorkspaceContext (requireWorkspace)
 * and the actor, recorded in the audit log. Rule violations are AppErrors with the API status.
 * They return IntegrationData for the server's own use: the API, the UI and MCP only ever see
 * toIntegrationStatus() of it.
 *
 * PERMISSIONS-V2: an integration belongs to one member inside one workspace. Editors and owners
 * connect their own (viewers are refused, ruling 9). Everything else (the config, an edit, a
 * test, a sync, a disconnect, stop sharing) is its owner's alone, whatever their role (a member
 * moved down to viewer keeps control of their own credentials, ruling 10): for anyone else the
 * integration does not exist (404), workspace owners included (integrationOwnership.ts).
 */
import { LIMITS } from '../config/limits.js';
import { AppError } from '../errors/AppError.js';
import { revokeGoogleGrant } from '../gcal/oauthCalendar.js';
import { checkGrantSelection, revokeProviderGrant } from './oauth/grants.js';
import type {
  CreateIntegrationInput,
  IntegrationData,
  IntegrationPatch,
} from '../models/definitions/Integration.js';
import {
  getAuditLogRepository,
  getContainerRepository,
  getCredentialRepository,
  getIntegrationRepository,
  getItemRepository,
  getWorkspaceRepository,
} from '../models/index.js';
import { PROVIDERS, ROLE_RANK, type Provider, type Role } from '../types/domain.js';
import type { WorkspaceContext } from './accessFilter.js';
import { findOwnIntegration, findOwnIntegrationIncludingDeleted } from './integrationOwnership.js';
import {
  assertSameAccount,
  isConnectableProvider,
  parseProviderConfig,
  planConnection,
  type ConnectionInput,
} from './integrationConfig.js';
import { assertTopicOf, topicIdBySlug } from './topics.js';
import { TOPIC_RULES_MAX } from './workspaces.js';

/** Who acts: a person in the UI (`agentId` null) or an agent key through MCP. */
export interface IntegrationActor {
  userId: string;
  agentId: string | null;
}

export interface UpdateIntegrationInput {
  label?: string | undefined;
  /** A topic of the workspace; null = none (Unsorted). */
  topicId?: string | null | undefined;
  config?: Record<string, unknown> | undefined;
  /** null clears it. */
  expiresAt?: Date | null | undefined;
}

// ─── Access ─────────────────────────────────────────────────────────────────

/** Requests route through requireWorkspace(minRole) too; services check again for MCP callers. */
export function assertRole(ctx: WorkspaceContext, minRole: Role): void {
  if (ROLE_RANK[ctx.role] < ROLE_RANK[minRole]) {
    throw new AppError(403, `Only an ${minRole === 'owner' ? 'owner' : 'editor'} can do this`);
  }
}

/** MongoDB's E11000: here, an account already connected in the workspace. */
export function isDuplicateKey(error: unknown): boolean {
  return (
    typeof error === 'object' && error !== null && (error as { code?: unknown }).code === 11000
  );
}

/** One audit entry about an integration. `meta` holds names and codes, never a secret or a value. */
export async function auditIntegration(
  ctx: Pick<WorkspaceContext, 'id'>,
  actor: IntegrationActor,
  action: string,
  integrationId: string,
  meta: Record<string, unknown>,
): Promise<void> {
  await (
    await getAuditLogRepository()
  ).append(ctx.id, {
    actorUserId: actor.userId,
    actorAgentId: actor.agentId,
    action,
    targetType: 'integration',
    targetId: integrationId,
    meta,
  });
}

// ─── List and connect ───────────────────────────────────────────────────────

type IntegrationCap = 'member' | 'workspace';

/**
 * Which cap (ruling 19) is exceeded with `extra` more integrations of the member's:
 * LIMITS.integrationsPerUserPerWorkspace of their own, LIMITS.integrationsPerWorkspace for every
 * member together. Null when both hold.
 */
async function capExceeded(
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

/** The check before connecting one more: null when there is room, else which cap is full. */
async function integrationCapReached(
  workspaceId: string,
  ownerUserId: string,
): Promise<IntegrationCap | null> {
  return capExceeded(workspaceId, ownerUserId, 1);
}

/**
 * A new integration, inserted only within both caps even when connects race (there are no
 * transactions here): check, insert, then count again with the new one included. Over a cap, the
 * new integration is soft-deleted again and the full cap comes back instead. Racers may all back
 * out, but the caps are never exceeded: the last of any set of kept integrations to count would
 * have seen them all. The insert's own errors (a duplicate account) propagate.
 */
export async function createWithinCaps(
  workspaceId: string,
  input: CreateIntegrationInput & { ownerUserId: string },
): Promise<{ created: IntegrationData; cap: null } | { created: null; cap: IntegrationCap }> {
  const full = await integrationCapReached(workspaceId, input.ownerUserId);
  if (full !== null) return { created: null, cap: full };
  const integrations = await getIntegrationRepository();
  const created = await integrations.create(workspaceId, input);
  const exceeded = await capExceeded(workspaceId, input.ownerUserId, 0);
  if (exceeded === null) return { created, cap: null };
  await integrations.softDelete(workspaceId, created.id);
  return { created: null, cap: exceeded };
}

/** Each member's providers here (their own live integrations), deduplicated, in a fixed order. */
export async function providersByMember(workspaceId: string): Promise<Map<string, Provider[]>> {
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

/**
 * The GitHub rule ("plan → GitHub connection"): a user's own repos are personal. Appends
 * `<login>/* → <the personal topic>`, lower case, in one atomic write
 * (WorkspaceRepository.appendTopicRule), unless the workspace has no `personal` topic, a rule with
 * that match exists in any case or the rules are at their cap. Workspace owners never add one.
 * The match when it was added, else null.
 */
export async function addOwnerTopicRule(
  workspaceId: string,
  login: string,
): Promise<string | null> {
  const personal = await topicIdBySlug(workspaceId, 'personal');
  if (personal === null) return null;
  const match = `${login.toLowerCase()}/*`;
  const added = await (
    await getWorkspaceRepository()
  ).appendTopicRule(workspaceId, { match, topicId: personal }, TOPIC_RULES_MAX);
  return added ? match : null;
}

/** Why a new integration is `error`: until `PUT …/credential`, it has no credential (R5). */
export const CREDENTIAL_MISSING = {
  code: 'credential_missing',
  message: 'Save the credential to finish connecting',
} as const;

/**
 * Editors and owners: a new integration of their own from the provider and its non-secret config
 * (validated per provider, integrationConfig.ts). It has no credential yet, so it starts as
 * `error` with `lastError` CREDENTIAL_MISSING (the API shows `error`) until `PUT …/credential`
 * saves one. 409 at either cap (createWithinCaps: they hold under concurrent connects) and for an
 * account this member already connected here (another member may connect the same account:
 * ruling 8). Audited as `integration.create`.
 */
export async function createIntegration(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  input: ConnectionInput,
  options: { demo?: boolean } = {},
): Promise<IntegrationData> {
  assertRole(ctx, 'editor');
  const plan = planConnection(input);
  if (plan.topicId !== undefined && plan.topicId !== null)
    await assertTopicOf(ctx.id, plan.topicId);
  const topicId =
    plan.topicId === undefined ? await topicIdBySlug(ctx.id, plan.defaultTopic) : plan.topicId;
  let result: Awaited<ReturnType<typeof createWithinCaps>>;
  try {
    result = await createWithinCaps(ctx.id, {
      connectedBy: actor.userId,
      ownerUserId: actor.userId,
      provider: plan.provider,
      accountId: plan.accountId,
      label: plan.label,
      authMethod: plan.authMethod,
      topicId,
      mode: plan.mode,
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
  const { created } = result;
  const meta: Record<string, unknown> = {
    provider: plan.provider,
    topicId,
    authMethod: plan.authMethod,
  };
  const login = plan.config['owner'];
  if (
    plan.provider === 'github' &&
    plan.config['ownerType'] === 'user' &&
    typeof login === 'string'
  ) {
    const topicRule = await addOwnerTopicRule(ctx.id, login);
    if (topicRule !== null) meta['topicRule'] = topicRule;
  }
  await auditIntegration(ctx, actor, 'integration.create', created.id, meta);
  return created;
}

// ─── Read the config ────────────────────────────────────────────────────────

/**
 * Its owner only (R2, ruling 1): the integration's non-secret config, parsed and validated again,
 * so only the provider's schema fields come back (a credential is never in config: Credentials
 * holds it). A stored config that no longer validates is never answered as stored: 409.
 */
export async function readIntegrationConfig(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
): Promise<Record<string, unknown>> {
  const integration = await findOwnIntegration(ctx, userId, integrationId);
  if (!isConnectableProvider(integration.provider)) {
    throw new AppError(409, 'This integration has no settings to show');
  }
  try {
    return parseProviderConfig(integration.provider, integration.config);
  } catch (error) {
    if (!(error instanceof AppError)) throw error;
    throw new AppError(409, 'This integration’s settings no longer validate: save them again');
  }
}

// ─── Edit ───────────────────────────────────────────────────────────────────

/**
 * Its owner only: the label, the topic, the config (validated again; it must stay on the same
 * account) and `expiresAt` (or null). Never the provider, the account, the status or the secret.
 * Audited as `integration.update` with the names of the changed fields, never their values.
 */
export async function updateIntegration(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  integrationId: string,
  input: UpdateIntegrationInput,
): Promise<IntegrationData> {
  const integration = await findOwnIntegration(ctx, actor.userId, integrationId);
  const patch: IntegrationPatch = {};
  if (input.label !== undefined) patch.label = input.label;
  if (input.topicId !== undefined) {
    if (input.topicId !== null) await assertTopicOf(ctx.id, input.topicId);
    patch.topicId = input.topicId;
  }
  if (input.config !== undefined) {
    if (!isConnectableProvider(integration.provider)) {
      throw new AppError(400, 'config: this integration has no settings to change');
    }
    const config = parseProviderConfig(integration.provider, input.config);
    assertSameAccount(integration, config);
    // A Jira site or ClickUp workspace is only one the grant covers (checked here, not just in the UI).
    patch.config = await checkGrantSelection(integration, config);
  }
  if (input.expiresAt !== undefined) patch.expiresAt = input.expiresAt;
  const changed = Object.keys(patch);
  if (changed.length === 0) {
    throw new AppError(400, 'Send a label, a topic, a config or expiresAt');
  }
  const updated = await (await getIntegrationRepository()).update(ctx.id, integrationId, patch);
  if (updated === null) throw new AppError(404, 'Not found');
  await auditIntegration(ctx, actor, 'integration.update', integrationId, { changed });
  return updated;
}

// ─── Disconnect ─────────────────────────────────────────────────────────────

/**
 * Its owner only (DATA.md §4, ruling 7): see disconnectSteps. A disconnect that stopped part-way
 * (a failure after step 1) resumes: DELETE on the soft-deleted integration runs the steps again
 * (each is idempotent) and answers 204, without a second audit entry.
 */
export async function disconnectIntegration(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  integrationId: string,
): Promise<void> {
  const integration = await findOwnIntegrationIncludingDeleted(ctx, actor.userId, integrationId);
  await disconnectSteps(ctx, actor, integration);
}

/**
 * Every integration a member owns in the workspace, disconnected (disconnectSteps): they left or
 * were removed (ruling 6), or their account is being deleted. Their soft-deleted ones go through
 * the steps again too, so a disconnect that stopped part-way (after the soft delete) loses its
 * credential and items on the next try; for a finished one the steps change nothing. Their
 * connectors stay on blocks as ids of an integration that is gone, which those blocks show as
 * "A source was removed" until edited. Their local to-dos stay. Returns how many it touched.
 */
export async function disconnectMemberIntegrations(
  ctx: Pick<WorkspaceContext, 'id'>,
  actor: IntegrationActor,
  memberUserId: string,
): Promise<number> {
  const theirs = await (
    await getIntegrationRepository()
  ).listForOwnerIncludingDeleted(ctx.id, memberUserId);
  for (const integration of theirs) await disconnectSteps(ctx, actor, integration);
  return theirs.length;
}

/**
 * Disconnects one integration, in this order:
 * 1. an OAuth grant goes back to the provider first, while the vault still opens the credential
 *    (best effort: a failure is logged and never blocks the disconnect);
 * 2. the integration gets `deletedAt`: the dispatcher stops, the vault no longer opens its
 *    credential, a sync run in flight sees the disconnect and deletes what it wrote since, and
 *    every block's connector to it stops reading (and sharing) anything; the
 *    `integration.disconnect` audit entry is written right after;
 * 3. the credential is hard-deleted, then checked gone (a survivor is a 500, loudly);
 * 4. its items and containers are soft-deleted (the purge job removes them 30 days later).
 */
async function disconnectSteps(
  ctx: Pick<WorkspaceContext, 'id'>,
  actor: IntegrationActor,
  integration: IntegrationData,
): Promise<void> {
  const integrations = await getIntegrationRepository();
  const integrationId = integration.id;
  // Google Calendar with OAuth: the grant goes back to Google first, while the vault still opens
  // the credential. Best effort: a failure is logged and never blocks the disconnect.
  if (
    integration.deletedAt === null &&
    integration.provider === 'google_calendar' &&
    integration.authMethod === 'oauth'
  ) {
    await revokeGoogleGrant(integration);
  }
  // The other OAuth providers: revoked where the provider has an endpoint (Linear); for the
  // others the page tells the user where to revoke.
  if (integration.deletedAt === null && integration.authMethod === 'oauth') {
    await revokeProviderGrant(integration);
  }
  // False when another request deleted it meanwhile: that one audits, this one finishes the steps.
  if (integration.deletedAt === null && (await integrations.softDelete(ctx.id, integrationId))) {
    await auditIntegration(ctx, actor, 'integration.disconnect', integrationId, {
      provider: integration.provider,
    });
  }
  const credentials = await getCredentialRepository();
  await credentials.delete(ctx.id, integrationId);
  if ((await credentials.findMeta(ctx.id, integrationId)) !== null) {
    throw new Error('A disconnect left its credential behind');
  }
  await (await getItemRepository()).softDeleteForIntegration(ctx.id, integrationId);
  await (await getContainerRepository()).softDeleteForIntegration(ctx.id, integrationId);
}
