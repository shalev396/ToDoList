/**
 * Effective rights of an agent key (MCP.md §4): the key's scopes ∩ what the user's membership
 * role permits, so a key never exceeds its user. On /api/mcp/readonly the write scopes are
 * ignored as well.
 */
import { Role as MemberRole } from '../../classes/base/Role.js';
import { ScopeSet } from '../../classes/base/ScopeSet.js';
import { READ_ONLY_SCOPES, ROLE_SCOPES, type AgentScope, type Role } from '../../types/domain.js';

export { ROLE_SCOPES, READ_ONLY_SCOPES };

/** The key's scopes that the role permits, in catalog order, without repeats (ScopeSet). */
export function effectiveScopes(keyScopes: readonly AgentScope[], role: Role): AgentScope[] {
  return ScopeSet.effective(keyScopes, role).toArray();
}

/** The effective scopes an endpoint honours: all of them, or only the read scopes on /readonly. */
export function endpointScopes(
  scopes: readonly AgentScope[],
  options: { readonly: boolean },
): AgentScope[] {
  return ScopeSet.of(scopes).onEndpoint(options).toArray();
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
  return ScopeSet.of(principal.scopes).onEndpoint({ readonly }).hasAll(tool.scopes);
}
