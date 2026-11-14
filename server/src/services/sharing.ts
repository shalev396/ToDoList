/**
 * "Stop sharing" (PERMISSIONS-V2, share-on-attach): an integration's owner takes it off every
 * block of the workspace, so its items are private to them again. Its owner only, whatever their
 * role; 404 for anyone else (integrationOwnership.ts). Audited as `integration.stop_sharing`.
 */
import { AuditTarget } from '../classes/base/AuditTarget.js';
import { AuditLog } from '../classes/AuditLog.js';
import { ItemPolicy } from '../classes/policies/ItemPolicy.js';
import type { WorkspaceContext } from './accessFilter.js';
import { removeConnectorEverywhere } from './dashboards.js';
import { findOwnIntegration, listOwnIntegrations } from './integrationOwnership.js';
import type { IntegrationActor } from './integrations.js';

/** The ids of the member's own integrations that are shared: a connector on some block. */
export async function sharedOwnIntegrationIds(
  ctx: Pick<WorkspaceContext, 'id'>,
  userId: string,
): Promise<string[]> {
  const [own, shared] = await Promise.all([
    listOwnIntegrations(ctx, userId),
    ItemPolicy.sharedConnectorIds(ctx.id),
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
  await AuditLog.record(
    { workspaceId: ctx.id, actor },
    'integration.stop_sharing',
    AuditTarget.integration(integration.id),
    {
      provider: integration.provider,
      dashboards,
    },
  );
  return { dashboards };
}
