import { getMembershipRepository, getWorkspaceRepository } from '../models/index.js';
import type { WorkspaceContext } from './accessFilter.js';

/**
 * The user's context in a workspace, or null when the workspace doesn't exist, is deleted, or the
 * user has no active membership. Callers answer 404 for null, so a workspace's existence never
 * leaks to non-members.
 */
export async function getWorkspaceContext(
  workspaceId: string,
  userId: string,
): Promise<WorkspaceContext | null> {
  const workspaces = await getWorkspaceRepository();
  const workspace = await workspaces.findById(workspaceId);
  // Missing (null) or soft-deleted workspaces both read as "not found".
  if (workspace?.deletedAt !== null) return null;
  const memberships = await getMembershipRepository();
  const membership = await memberships.find(workspaceId, userId);
  if (membership === null) return null;
  return {
    id: workspace.id,
    role: membership.role,
    settings: workspace.settings,
  };
}
