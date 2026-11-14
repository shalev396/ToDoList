/**
 * Who an MCP call acts as (MCP.md §4): the agent key's user, in the key's workspace, with the
 * user's current membership role. Effective scopes are the key's scopes ∩ that role, so a key
 * never exceeds its user. No active membership (the user left or was removed, or the workspace
 * was deleted) means no principal: the caller answers 401.
 */
import type { Response } from 'express';

import type { AgentKeyData } from '../../models/index.js';
import type { WorkspaceContext } from '../../services/accessFilter.js';
import { getWorkspaceContext } from '../../services/workspaceContext.js';
import type { AgentScope, Role } from '../../types/domain.js';
import { effectiveScopes } from './scopes.js';

export interface AgentPrincipal {
  userId: string;
  workspaceId: string;
  /** The agent key's id: `actorAgentId` in the audit log. */
  agentId: string;
  role: Role;
  /** Effective scopes: the key's scopes that the role permits. */
  scopes: AgentScope[];
}

/** A resolved principal with the workspace context the services take (requireWorkspace's shape). */
export interface AuthenticatedAgent {
  principal: AgentPrincipal;
  workspace: WorkspaceContext;
}

/** The principal behind a usable key, or null when its user is no longer an active member. */
export async function resolvePrincipal(key: AgentKeyData): Promise<AuthenticatedAgent | null> {
  const workspace = await getWorkspaceContext(key.workspaceId, key.userId);
  if (workspace === null) return null;
  return {
    principal: {
      userId: key.userId,
      workspaceId: key.workspaceId,
      agentId: key.id,
      role: workspace.role,
      scopes: effectiveScopes(key.scopes, workspace.role),
    },
    workspace,
  };
}

const LOCALS_KEY = 'mcpAgent';

/** Stores the authenticated agent for the rest of this request's middleware chain. */
export function setRequestAgent(res: Response, agent: AuthenticatedAgent): void {
  res.locals[LOCALS_KEY] = agent;
}

/** The agent mcpAuth authenticated for this request; throws if it did not run. */
export function requestAgent(res: Response): AuthenticatedAgent {
  const agent = res.locals[LOCALS_KEY] as AuthenticatedAgent | undefined;
  if (agent === undefined) throw new Error('MCP request reached a handler without mcpAuth');
  return agent;
}
