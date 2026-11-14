/**
 * Who may see what inside a workspace (DATA.md §5, PERMISSIONS-V2). Every query over Items or
 * Containers starts from these filters: the query compiler injects them as its first stage, and
 * services use them for direct reads. They are pure functions so the rule lives in exactly one
 * place; itemAccess.ts resolves the ItemAccess they take, once per request.
 *
 * A workspace is shared as a whole (every member sees every topic), but integrations are not:
 * what I can see = my own integrations' items ∪ the items of integrations attached as a connector
 * on any block of the workspace (share-on-attach) ∪ local to-dos I may see (shared ones, and my
 * own private ones).
 */
import type { WorkspaceSettings } from '../models/definitions/Workspace.js';
import type { Provider, Role } from '../types/domain.js';

/** The caller's standing in one workspace, resolved by requireWorkspace / the MCP principal. */
export interface WorkspaceContext {
  id: string;
  role: Role;
  settings: WorkspaceSettings;
  /**
   * Only these topics (ids; null = Unsorted): a narrowing an MCP read tool asks for (MCP.md §6),
   * never a member's limit. Absent means every topic.
   */
  onlyTopics?: readonly (string | null)[];
}

/** An integration whose items the caller may see, with what connectors and dedup need. */
export interface VisibleIntegration {
  id: string;
  provider: Provider;
  /** The account on the provider side: two integrations of one account mirror the same records. */
  accountId: string;
  ownerUserId: string;
}

/**
 * What the caller may see of a workspace's items and containers (itemAccess.ts):
 * - `integrations`: their own live integrations plus the shared ones (attached to a block);
 * - `local`: local to-dos, `visible` (shared ones and their own) or `own` (only their own: a
 *   calendar push copies nobody else's data, ruling 12).
 */
export interface ItemAccess {
  userId: string;
  integrations: readonly VisibleIntegration[];
  local: 'visible' | 'own';
}

type Narrowing = Pick<WorkspaceContext, 'id' | 'onlyTopics'>;

function topicFilter(ws: Narrowing): Record<string, unknown> {
  return ws.onlyTopics === undefined ? {} : { topicId: { $in: [...ws.onlyTopics] } };
}

/**
 * Items the caller may see: this workspace, not deleted, from an integration in `access`, or a
 * local to-do they may see (`integrationId` null: shared, or their own).
 */
export function baseItemFilter(ws: Narrowing, access: ItemAccess): Record<string, unknown> {
  const ids = access.integrations.map((integration) => integration.id);
  return {
    workspaceId: ws.id,
    deletedAt: null,
    ...topicFilter(ws),
    $or: [
      ...(ids.length === 0 ? [] : [{ integrationId: { $in: ids } }]),
      { integrationId: null, ownerUserId: access.userId },
      ...(access.local === 'visible' ? [{ integrationId: null, visibility: 'workspace' }] : []),
    ],
    ...copyAbsorptionFilter(access.userId),
  };
}

/** Containers the caller may see: this workspace, not deleted, from an integration in `access`. */
export function baseContainerFilter(ws: Narrowing, access: ItemAccess): Record<string, unknown> {
  return {
    workspaceId: ws.id,
    deletedAt: null,
    ...topicFilter(ws),
    integrationId: { $in: access.integrations.map((integration) => integration.id) },
  };
}

/**
 * One row, not three (H5): a mirrored provider copy of a local to-do is hidden from whoever can
 * see that to-do (it is shared, or the viewer created it); the to-do's own row shows the copy.
 * It composes WITH the access above, never instead of it, and applies to lists only: a read of
 * one item by id uses baseItemFilterUnabsorbed. Filtering by provider alone shows the copy, since
 * the to-do does not match that filter. One $match, so counts and charts agree.
 */
export function copyAbsorptionFilter(userId: string): Record<string, unknown> {
  return {
    $nor: [
      {
        'overlay.copyOf': { $type: 'string' },
        $or: [{ 'overlay.copyOfShared': true }, { 'overlay.copyOfOwner': userId }],
      },
    ],
  };
}

/** The positive provider conditions an `$and` chain of a compiled filter puts on `source.provider`. */
function providerConditions(filter: unknown, found: unknown[] = []): unknown[] {
  if (typeof filter !== 'object' || filter === null) return found;
  for (const [key, value] of Object.entries(filter)) {
    if (key === '$and' && Array.isArray(value)) {
      for (const part of value as unknown[]) providerConditions(part, found);
    } else if (key === 'source.provider') {
      found.push(value);
    }
  }
  return found;
}

/** True when the filter asks for providers, none of which is `local`. */
function excludesLocal(userFilter: unknown): boolean {
  return providerConditions(userFilter).some((condition) => {
    if (typeof condition === 'string') return condition !== 'local';
    if (typeof condition !== 'object' || condition === null) return false;
    const { $eq, $in } = condition as { $eq?: unknown; $in?: unknown };
    if (typeof $eq === 'string') return $eq !== 'local';
    return Array.isArray($in) && $in.length > 0 && !($in as unknown[]).includes('local');
  });
}

function withoutAbsorption(base: Record<string, unknown>, userId: string): Record<string, unknown> {
  const absorption = copyAbsorptionFilter(userId);
  if (JSON.stringify(base['$nor']) !== JSON.stringify(absorption['$nor'])) return base;
  return Object.fromEntries(Object.entries(base).filter(([key]) => key !== '$nor'));
}

/**
 * baseItemFilter for a read that also applies `userFilter` (a `$match` document): a filter by
 * provider that leaves out `local` shows a provider copy, since the local to-do that would absorb
 * it does not match (H5). Every other read hides the copy.
 */
export function baseItemFilterFor(
  ws: Narrowing,
  access: ItemAccess,
  userFilter: unknown,
): Record<string, unknown> {
  const base = baseItemFilter(ws, access);
  return excludesLocal(userFilter) ? withoutAbsorption(base, access.userId) : base;
}

/**
 * The same access, without the absorption rule. A read of ONE item by id (open it, pin it) or of
 * what exists (facets) is about who may see the item, and absorption does not change that.
 */
export function baseItemFilterUnabsorbed(
  ws: Narrowing,
  access: ItemAccess,
): Record<string, unknown> {
  return withoutAbsorption(baseItemFilter(ws, access), access.userId);
}
