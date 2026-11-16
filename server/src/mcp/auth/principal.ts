/**
 * Who an MCP call acts as (MCP.md §4): the agent key's user, in the key's workspace, with the
 * user's current membership role. Effective scopes are the key's scopes ∩ that role, so a key
 * never exceeds its user. No active membership (the user left or was removed, or the workspace
 * was deleted) means no principal: the caller answers 401.
 */
import type { Response } from 'express';

import { Actor, type ActorOrigin } from '../../classes/base/Actor.js';
import { Caller, type WorkspaceContext } from '../../classes/base/Caller.js';
import { ScopeSet } from '../../classes/base/ScopeSet.js';
import type { AgentKeyData } from '../../models/definitions/AgentKey.js';
import type { AgentScope, Role } from '../../types/domain.js';
import type { ToolContext } from '../tool.js';

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
  /** The agent key, acting for its user in the key's workspace, from this request's origin. */
  caller: Caller;
  /** The MCP resource a sign-in grant was issued for; null for an agent key. */
  resource: string | null;
}

/**
 * The principal behind a usable key, or null when its user is no longer an active member.
 * `origin`: the request's address and user agent, which the audit log records.
 */
export async function resolvePrincipal(
  key: AgentKeyData,
  origin: ActorOrigin = {},
): Promise<AuthenticatedAgent | null> {
  const caller = await Caller.enter(key.workspaceId, Actor.agent(key.userId, key.id, origin));
  if (caller === null) return null;
  const workspace = caller.context;
  return {
    principal: {
      userId: key.userId,
      workspaceId: key.workspaceId,
      agentId: key.id,
      role: workspace.role,
      scopes: ScopeSet.effective(key.scopes, workspace.role).toArray(),
    },
    workspace,
    caller,
    resource: key.resource,
  };
}

/**
 * The caller a tool call acts as: the one the request authenticated, or (a context built without
 * one, as tests build them) the principal's agent key in its workspace.
 *
 * Identity and origin only (who acts, for services and the audit log). It is not narrowed to a
 * read tool's topics (`ctx.workspace.onlyTopics`, itemViews.ts): a check that should honour that
 * narrowing builds its caller from the narrowed workspace context.
 */
export function toolCaller(ctx: ToolContext): Caller {
  return (
    ctx.caller ??
    Caller.fromContext(ctx.workspace, Actor.agent(ctx.principal.userId, ctx.principal.agentId))
  );
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
