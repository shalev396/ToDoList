import { Actor } from '../classes/base/Actor.js';
import { Caller, type WorkspaceContext } from '../classes/base/Caller.js';

/**
 * The user's standing in a workspace (Caller.enter), or null when the workspace doesn't exist,
 * is deleted, or the user has no active membership. Kept for the tests that resolve a context by
 * this name; code enters a Caller.
 */
export async function getWorkspaceContext(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceContext | null> {
  return (await Caller.enter(workspaceId, Actor.user(userId)))?.context ?? null;
}
