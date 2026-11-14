/**
 * Integration ownership (PERMISSIONS-V2): an integration belongs to one member inside one
 * workspace. Only its owner sees its details or manages it: the config, a test, a sync, an edit,
 * a disconnect, its sync runs. For anyone else it does not exist (404, never 403), workspace
 * owners included (rulings 1, 2 and 23c).
 *
 * `isOwnIntegration` is the one test: the manage actions here, connector adds on blocks
 * (dashboards.ts) and writes to providers (H5) all ask it.
 */
import { AppError } from '../errors/AppError.js';
import type { IntegrationData } from '../models/definitions/Integration.js';
import { getIntegrationRepository } from '../models/index.js';
import type { WorkspaceContext } from './accessFilter.js';

/** True when `userId` owns the integration. */
export function isOwnIntegration(
  integration: Pick<IntegrationData, 'ownerUserId'>,
  userId: string,
): boolean {
  return integration.ownerUserId === userId;
}

function notFound(): AppError {
  return new AppError(404, 'Not found');
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
  const integration = await (await getIntegrationRepository()).findById(ctx.id, integrationId);
  if (integration === null || !isOwnIntegration(integration, userId)) throw notFound();
  return integration;
}

/** findOwnIntegration, soft-deleted ones too: a disconnect that stopped part-way resumes. */
export async function findOwnIntegrationIncludingDeleted(
  ctx: Pick<WorkspaceContext, 'id'>,
  userId: string,
  integrationId: string,
): Promise<IntegrationData> {
  const integration = await (
    await getIntegrationRepository()
  ).findIncludingDeleted(ctx.id, integrationId);
  if (integration === null || !isOwnIntegration(integration, userId)) throw notFound();
  return integration;
}

/** The caller's own live integrations in this workspace, oldest first. */
export async function listOwnIntegrations(
  ctx: Pick<WorkspaceContext, 'id'>,
  userId: string,
): Promise<IntegrationData[]> {
  return (await getIntegrationRepository()).listForOwner(ctx.id, userId);
}
