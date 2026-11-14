/**
 * Share-on-attach (PERMISSIONS-V2): which integrations' items a member may see, resolved from the
 * data on every request, never from a stored flag that could drift. A request that needs it twice
 * (an MCP read, a dashboard's previews) resolves it once (requestMemo.ts); the next request
 * resolves it again, so "Stop sharing" holds from the next request on.
 *
 * - An integration is shared once its id is a connector on any block of any live dashboard of
 *   the workspace: drafts and published copies, every page, private dashboards too.
 * - A member sees their own integrations' items, the shared ones', and local to-dos they may see.
 * - A calendar push copies only the member's own: their integrations and their own to-dos
 *   (ruling 12).
 *
 * blockScope then narrows what one block reads to its connectors and deduplicates records that
 * two members' integrations of one account both mirror (ruling 8).
 */
import type { IntegrationData } from '../models/definitions/Integration.js';
import { getDashboardRepository, getIntegrationRepository } from '../models/index.js';
import { LOCAL_CONNECTOR } from '../types/builder.js';
import type { ItemAccess, VisibleIntegration, WorkspaceContext } from './accessFilter.js';
import { isOwnIntegration } from './integrationOwnership.js';
import { forgetForRequest, memoForRequest } from './requestMemo.js';

/** This request's memo keys for one workspace's access (requestMemo.ts). */
function memoKey(workspaceId: string, what: string): string {
  return `item-access:${workspaceId}:${what}`;
}

/** A write in this request changed what is shared (a dashboard write, "Stop sharing"). */
export function forgetItemAccess(workspaceId: string): void {
  forgetForRequest(memoKey(workspaceId, ''));
}

function visible(integration: IntegrationData): VisibleIntegration {
  return {
    id: integration.id,
    provider: integration.provider,
    accountId: integration.accountId,
    ownerUserId: integration.ownerUserId,
  };
}

/** Connector ids on any block of the workspace (`local` included when a block reads to-dos). */
export async function sharedConnectorIds(workspaceId: string): Promise<ReadonlySet<string>> {
  return memoForRequest(
    memoKey(workspaceId, 'shared'),
    async () => new Set(await (await getDashboardRepository()).listConnectorIds(workspaceId)),
  );
}

/** Whether the integration is shared: a connector on some block of its workspace. */
export async function isIntegrationShared(
  integration: Pick<IntegrationData, 'id' | 'workspaceId'>,
): Promise<boolean> {
  return (await sharedConnectorIds(integration.workspaceId)).has(integration.id);
}

/**
 * What `userId` may see in the workspace: their own live integrations first, then the shared
 * ones (oldest first in each), and the local to-dos they may see.
 */
export async function resolveItemAccess(
  ws: Pick<WorkspaceContext, 'id'>,
  userId: string,
): Promise<ItemAccess> {
  return memoForRequest(memoKey(ws.id, `user:${userId}`), async () => {
    const [all, shared] = await Promise.all([
      (await getIntegrationRepository()).list(ws.id),
      sharedConnectorIds(ws.id),
    ]);
    const own = all.filter((integration) => isOwnIntegration(integration, userId));
    const others = all.filter(
      (integration) => !isOwnIntegration(integration, userId) && shared.has(integration.id),
    );
    return { userId, integrations: [...own, ...others].map(visible), local: 'visible' as const };
  });
}

/** Only the member's own: their live integrations and their own local to-dos (ruling 12). */
export async function ownItemAccess(
  ws: Pick<WorkspaceContext, 'id'>,
  userId: string,
): Promise<ItemAccess> {
  const own = await (await getIntegrationRepository()).listForOwner(ws.id, userId);
  return { userId, integrations: own.map(visible), local: 'own' };
}

/** How one block reads for one viewer: its connectors, and the dedup order when needed. */
export interface BlockScope {
  /** The block's connectors (empty: nothing), or absent: everything the viewer may see. */
  connectors?: readonly string[];
  /**
   * Integration ids in order of preference, when two of the integrations the block reads mirror
   * one account: each record is then kept once, from the first integration in this list.
   */
  dedup?: readonly string[];
}

/**
 * The block's scope for `access`: its connectors as they are (only what the viewer may see is
 * ever read: the base filter applies first), and a dedup order when two of the integrations it
 * reads share an account. The order prefers the block's first connectors, which are its
 * creator's: a block is made with its creator's own connectors and later ones are appended. A
 * block without a connectors field prefers the viewer's own integrations; one with an empty list
 * reads nothing.
 */
export function blockScope(
  access: ItemAccess,
  connectors: readonly string[] | undefined,
): BlockScope {
  const byId = new Map(access.integrations.map((integration) => [integration.id, integration]));
  const read =
    connectors === undefined
      ? access.integrations
      : connectors.flatMap((id) => {
          const integration = id === LOCAL_CONNECTOR ? undefined : byId.get(id);
          return integration === undefined ? [] : [integration];
        });
  const accounts = new Set<string>();
  let shared = false;
  for (const integration of read) {
    const key = `${integration.provider}\u0000${integration.accountId}`;
    if (accounts.has(key)) shared = true;
    accounts.add(key);
  }
  return {
    ...(connectors === undefined ? {} : { connectors }),
    ...(shared ? { dedup: read.map((integration) => integration.id) } : {}),
  };
}
