import { z } from 'zod';

import { providersByMember } from '../../../services/integrations.js';
import { listMembers } from '../../../services/workspaces.js';
import { defineTool } from '../../tool.js';
import { MemberView, toMemberView } from './views.js';

export const workspaceListMembers = defineTool({
  name: 'workspace_list_members',
  title: 'List members',
  description:
    'Active members of the workspace, oldest first: each with userId, name, email, role (owner, editor or viewer) and the providers of the integrations they own here (never their accounts). Every member sees the whole workspace; each integration is its owner’s alone.',
  toolset: 'workspace',
  inputSchema: z.strictObject({}),
  outputSchema: z.object({ members: z.array(MemberView) }),
  annotations: {
    readOnlyHint: true,
    destructiveHint: false,
    idempotentHint: true,
    openWorldHint: false,
  },
  scopes: ['workspace:read'],
  minRole: 'viewer',
  async handler(ctx) {
    const members = await listMembers(ctx.workspace);
    const providers = await providersByMember(ctx.workspace.id);
    return {
      output: { members: members.map((member) => toMemberView(member, providers)) },
      target: { type: 'workspace', id: ctx.workspace.id },
    };
  },
});
