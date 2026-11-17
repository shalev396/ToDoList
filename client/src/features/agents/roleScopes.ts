import { AGENT_SCOPES, ROLE_SCOPES, type AgentScope, type Role } from '@api-types/domain.ts';

/** The scopes a member of this role may put on a key (the server's table), in catalog order. */
export function scopesForRole(role: Role): readonly AgentScope[] {
  const permitted = new Set<AgentScope>(ROLE_SCOPES[role]);
  return AGENT_SCOPES.filter((scope) => permitted.has(scope));
}
