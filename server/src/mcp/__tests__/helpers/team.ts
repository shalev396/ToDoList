/**
 * Test-only workspaces for MCP tests: an owner, an editor and a viewer, made through the same
 * services the API uses. Models are imported lazily: call this only after the test database is up.
 */
import type { UserData, WorkspaceData } from '../../../models/index.js';
import { newUser } from '../../../testing/workspaceFixtures.js';

export interface Team {
  workspace: WorkspaceData;
  owner: UserData;
  editor: UserData;
  viewer: UserData;
}

export async function newTeam(label: string): Promise<Team> {
  const { createWorkspace } = await import('../../../services/workspaces.js');
  const { getMembershipRepository } = await import('../../../models/index.js');
  const owner = await newUser(`${label}-owner`);
  const editor = await newUser(`${label}-editor`);
  const viewer = await newUser(`${label}-viewer`);
  const workspace = await createWorkspace(owner, { name: `Team ${label}` });
  const memberships = await getMembershipRepository();
  await memberships.create(workspace.id, { userId: editor.id, role: 'editor' });
  await memberships.create(workspace.id, { userId: viewer.id, role: 'viewer' });
  return { workspace, owner, editor, viewer };
}
