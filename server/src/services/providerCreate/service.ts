/**
 * Creating a local to-do in the caller's own providers too (H5, D19): the one place TodoList
 * writes a NEW item to a provider, and only after an explicit user action. What the chips show and
 * the funnel's steps are here; the create itself is the to-do's (Todo#copyTo, TodoCopy: its gates,
 * the hourly limit, the audit and the read-back). No database here: the reads are the classes'.
 */
import { AppError } from '../../errors/AppError.js';
import { ProviderHttpError } from '../../sync/http.js';
import type {
  CreatableProvider,
  CreateCopyOutcome,
  CreateCopyRequestBody,
  CreateOptionsQuery,
  CreateOptionsResponseData,
  CreateTargetsResponseData,
} from '../../types/providerCreate.js';
import type { ActorRef } from '../../classes/base/Actor.js';
import { Caller } from '../../classes/base/Caller.js';
import { Actor } from '../../classes/base/Actor.js';
import { Integration, isCreateFunnel } from '../../classes/integration/index.js';
import { isCreatableProvider, Todo } from '../../classes/item/index.js';
import { ItemPolicy } from '../../classes/policies/ItemPolicy.js';
import type { WorkspaceContext } from '../accessFilter.js';
import { logger } from '../logger.js';

export { failureFor, isCreatableProvider, safeCopyUrl } from '../../classes/item/index.js';
export type { CreatableProvider };
// ─── what the chips show ────────────────────────────────────────────────────

/**
 * The caller's own integrations that can create items, one chip each. `writable` is false when
 * nothing can be created there now: read-only (`mode`), or creating is off for it on this server.
 */
export async function listCreateTargets(
  ctx: WorkspaceContext,
  userId: string,
): Promise<CreateTargetsResponseData> {
  const caller = Caller.fromContext(ctx, Actor.user(userId));
  const targets: CreateTargetsResponseData['targets'] = [];
  for (const integration of await Integration.listVisible(caller)) {
    const { provider } = integration;
    if (
      !isCreatableProvider(provider) ||
      !integration.isOwnedBy(userId) ||
      integration.status !== 'active'
    ) {
      continue;
    }
    // What its way of connecting can create (Google Calendar: its OAuth grant only).
    if (!integration.canCreate) continue;
    targets.push({
      integrationId: integration.id,
      provider,
      label: integration.label,
      authMethod: integration.authMethod,
      needsConsent: await integration.needsCreateConsent(),
      writable: integration.allowsWrites,
      mode: integration.mode.name,
      canSwitchMode: integration.canSwitchMode,
      shared: await ItemPolicy.isShared(integration),
    });
  }
  return { targets };
}

/**
 * One funnel step's choices. Editor or above; the integration is the caller's own (404), and could
 * be written to now: 409 `provider_writes_off` (demo data, fixtures), 409 `integration_read_only`.
 */
export async function createOptions(
  ctx: WorkspaceContext,
  userId: string,
  integrationId: string,
  query: CreateOptionsQuery,
): Promise<CreateOptionsResponseData> {
  const caller = Caller.fromContext(ctx, Actor.user(userId));
  caller.require('editor');
  const integration = await Integration.findOwn(caller, integrationId);
  if (!isCreatableProvider(integration.provider) || !isCreateFunnel(integration)) {
    throw new AppError(409, 'Nothing can be created in this provider');
  }
  // Nothing is read at a provider that cannot be written to.
  integration.assertWritable(caller);
  try {
    return await integration.createOptions(caller, query);
  } catch (error) {
    if (error instanceof AppError) throw error;
    if (error instanceof ProviderHttpError && error.code === 'auth_failed') {
      throw new AppError(409, `${integration.provider} refused the connection: reconnect it`);
    }
    logger.warn('Create options could not be read', {
      integrationId,
      errorName: error instanceof Error ? error.name : typeof error,
    });
    throw new AppError(502, `${integration.provider} did not answer. Try again in a moment.`);
  }
}

// ─── the create ─────────────────────────────────────────────────────────────

/**
 * Creates the to-do's copy in one provider (Todo#copyTo). Editor or above, the caller's own to-do
 * (404 otherwise) and integration. 409 `provider_writes_off` when creating is off for it here, 409
 * `integration_read_only` while it is read-only (nothing is reserved or sent), 429
 * `create_rate_limited` past the hourly limit, 400 for a bad target, `needs_due_date` for a
 * calendar event without a due date. Everything the provider decides comes back as an outcome.
 */
export async function createCopy(
  ctx: WorkspaceContext,
  actor: ActorRef,
  todoId: string,
  body: CreateCopyRequestBody,
  now: Date = new Date(),
): Promise<CreateCopyOutcome> {
  return Todo.copyOwn(Caller.fromContext(ctx, actor), todoId, body, now);
}
