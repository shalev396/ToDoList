import type { AgentScope } from '@api-types/domain.ts';

/**
 * The parts of the API's ConsentView these helpers read. Declared here, not imported from
 * api-contracts, so the unit-test project (import-free server types only) can compile this file;
 * the real ConsentView is assignable to it.
 */
export interface ConsentViewLike {
  clientName: string;
  workspaces: readonly {
    id: string;
    allowed: AgentScope[];
    preselected: AgentScope[];
  }[];
}

export interface ConsentChoice {
  workspaceId: string;
  scopes: AgentScope[];
  name: string;
}

/** What each workspace lets this member give, and what the page ticks first. */
export function scopesFor(
  view: ConsentViewLike,
  workspaceId: string,
): { allowed: AgentScope[]; preselected: AgentScope[] } {
  const entry = view.workspaces.find((workspace) => workspace.id === workspaceId);
  return { allowed: entry?.allowed ?? [], preselected: entry?.preselected ?? [] };
}

/** The current workspace when it is listed, else the first; its preselected scopes; the client's name. */
export function initialChoice(
  view: ConsentViewLike,
  currentWorkspaceId: string | null,
): ConsentChoice {
  const listed = view.workspaces.some((workspace) => workspace.id === currentWorkspaceId);
  const workspaceId = listed ? currentWorkspaceId : (view.workspaces[0]?.id ?? '');
  return {
    workspaceId: workspaceId ?? '',
    scopes: [...scopesFor(view, workspaceId ?? '').preselected],
    name: view.clientName,
  };
}
