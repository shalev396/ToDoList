/**
 * "Stop sharing" (PERMISSIONS-V2, share-on-attach): an integration's owner takes it off every
 * block of the workspace, so its items are private to them again. Its owner only, whatever their
 * role; 404 for anyone else (integrationOwnership.ts). Audited as `integration.stop_sharing`.
 */
import type { WorkspaceContext } from './accessFilter.js';
import { removeConnectorEverywhere } from './dashboards.js';
import { findOwnIntegration, listOwnIntegrations } from './integrationOwnership.js';
import { auditIntegration, type IntegrationActor } from './integrations.js';
import { sharedConnectorIds } from './itemAccess.js';

/** The ids of the member's own integrations that are shared: a connector on some block. */
export async function sharedOwnIntegrationIds(
  ctx: Pick<WorkspaceContext, 'id'>,
  userId: string,
): Promise<string[]> {
  const [own, shared] = await Promise.all([
    listOwnIntegrations(ctx, userId),
    sharedConnectorIds(ctx.id),
  ]);
  return own.filter((integration) => shared.has(integration.id)).map(({ id }) => id);
}

export async function stopSharingIntegration(
  ctx: WorkspaceContext,
  actor: IntegrationActor,
  integrationId: string,
): Promise<{ dashboards: number }> {
  const integration = await findOwnIntegration(ctx, actor.userId, integrationId);
  const dashboards = await removeConnectorEverywhere(ctx, actor, integration.id);
  await auditIntegration(ctx, actor, 'integration.stop_sharing', integration.id, {
    provider: integration.provider,
    dashboards,
  });
  return { dashboards };
}
