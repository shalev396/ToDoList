/**
 * Loading an integration for its owner. The rule (only its owner sees or manages it; for anyone
 * else it does not exist: 404, never 403, workspace owners included) is IntegrationPolicy's
 * (classes/policies/IntegrationPolicy.ts); these reads apply it.
 */
import { IntegrationPolicy } from '../classes/policies/IntegrationPolicy.js';
import { NotFoundError } from '../errors/NotFoundError.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import { getIntegrationRepository } from '../models/index.js';
import type { WorkspaceContext } from './accessFilter.js';

/** True when `userId` owns the integration (IntegrationPolicy.isOwn). */
export function isOwnIntegration(
  integration: Pick<IntegrationData, 'ownerUserId'>,
  userId: string,
): boolean {
  return IntegrationPolicy.isOwn(integration, userId);
}

/** The integration when `userId` owns it; otherwise the policy's refusal (404). */
function owned(integration: IntegrationData | null, userId: string): IntegrationData {
  if (integration === null || !IntegrationPolicy.isOwn(integration, userId)) {
    throw new NotFoundError();
  }
  return integration;
}

/**
 * The caller's own live integration in this workspace; 404 for anything else: another member's,
 * another workspace's, a deleted one or an id that never existed all read the same.
 */
export async function findOwnIntegration(
  ctx: Pick<WorkspaceContext, 'id'>,
  userId: string,
  integrationId: string,
): Promise<IntegrationData> {
  return owned(await (await getIntegrationRepository()).findById(ctx.id, integrationId), userId);
}

/** findOwnIntegration, soft-deleted ones too: a disconnect that stopped part-way resumes. */
export async function findOwnIntegrationIncludingDeleted(
  ctx: Pick<WorkspaceContext, 'id'>,
  userId: string,
  integrationId: string,
): Promise<IntegrationData> {
  return owned(
    await (await getIntegrationRepository()).findIncludingDeleted(ctx.id, integrationId),
    userId,
  );
}

/** The caller's own live integrations in this workspace, oldest first. */
export async function listOwnIntegrations(
  ctx: Pick<WorkspaceContext, 'id'>,
  userId: string,
): Promise<IntegrationData[]> {
  return (await getIntegrationRepository()).listForOwner(ctx.id, userId);
}
