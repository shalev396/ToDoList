/**
 * Effective rights of an agent key (MCP.md §4): the key's scopes ∩ what the user's membership
 * role permits, so a key never exceeds its user. On /api/mcp/readonly the write scopes are
 * ignored as well.
 */
import { Role as MemberRole } from '../../classes/base/Role.js';
import {
  AGENT_SCOPES,
  READ_ONLY_SCOPES,
  ROLE_SCOPES,
  type AgentScope,
  type Role,
} from '../../types/domain.js';

export { ROLE_SCOPES, READ_ONLY_SCOPES };

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
  if (!MemberRole.of(principal.role).atLeast(tool.minRole)) return false;
  const usable = endpointScopes(principal.scopes, { readonly });
  return tool.scopes.every((scope) => usable.includes(scope));
}
