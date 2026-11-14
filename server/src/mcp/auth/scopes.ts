/**
 * Effective rights of an agent key (MCP.md §4): the key's scopes ∩ what the user's membership
 * role permits, so a key never exceeds its user. On /api/mcp/readonly the write scopes are
 * ignored as well.
 */
import { AGENT_SCOPES, ROLE_RANK, type AgentScope, type Role } from '../../types/domain.js';

/**
 * The scopes each role may use through a key, read off the DATA.md §5 role matrix (and the REST
 * roles of the same actions): reading is everyone's; local items, sync, the calendar push, the
 * builder and connecting one's own integrations (PERMISSIONS-V2 ruling 9) are editors'; sharing
 * and publishing are owners'. Integration tools act on the key user's own integrations only.
 */
export const ROLE_SCOPES: Readonly<Record<Role, readonly AgentScope[]>> = {
  // integrations:connect: a viewer still disconnects their own integrations (ruling 10); they
  // can't connect new ones (integrations_start_connect needs an editor).
  viewer: ['read', 'integrations:read', 'integrations:connect', 'workspace:read'],
  editor: [
    'read',
    'items:write',
    'sync',
    'gcal:write',
    'providers:create',
    'integrations:read',
    'integrations:connect',
    'workspace:read',
    'builder:write',
  ],
  owner: AGENT_SCOPES,
};

/** The scopes that only read: all that /api/mcp/readonly keeps. */
export const READ_ONLY_SCOPES: readonly AgentScope[] = [
  'read',
  'integrations:read',
  'workspace:read',
];

/** The key's scopes that the role permits, in catalog order, without repeats. */
export function effectiveScopes(keyScopes: readonly AgentScope[], role: Role): AgentScope[] {
  const granted = new Set(keyScopes);
  const permitted = new Set(ROLE_SCOPES[role]);
  return AGENT_SCOPES.filter((scope) => granted.has(scope) && permitted.has(scope));
}

/** The effective scopes an endpoint honours: all of them, or only the read scopes on /readonly. */
export function endpointScopes(
  scopes: readonly AgentScope[],
  options: { readonly: boolean },
): AgentScope[] {
  return AGENT_SCOPES.filter(
    (scope) => scopes.includes(scope) && (!options.readonly || READ_ONLY_SCOPES.includes(scope)),
  );
}

/** What a tool needs: every one of its scopes, at least its role, and read-only on /readonly. */
export interface ToolAccess {
  scopes: readonly AgentScope[];
  minRole: Role;
  readOnly: boolean;
}

/** Whether a principal with these (effective) scopes and role may call the tool. */
export function canCall(
  tool: ToolAccess,
  principal: { role: Role; scopes: readonly AgentScope[] },
  options: { readonly?: boolean } = {},
): boolean {
  const readonly = options.readonly === true;
  if (readonly && !tool.readOnly) return false;
  if (ROLE_RANK[principal.role] < ROLE_RANK[tool.minRole]) return false;
  const usable = endpointScopes(principal.scopes, { readonly });
  return tool.scopes.every((scope) => usable.includes(scope));
}
