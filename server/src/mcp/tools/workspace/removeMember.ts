import { z } from 'zod';

import { Member } from '../../../classes/workspace/index.js';
import { confirmField } from '../../middleware/confirm.js';
import { toolCaller } from '../../auth/principal.js';
import { defineTool } from '../../tool.js';
import { findMemberView, MemberUserId, MemberView } from './views.js';

const Output = z.object({
  applied: z.boolean().describe('false: a preview, nothing changed'),
  member: MemberView.describe('The member, as they were before'),
  summary: z.string(),
});

export const workspaceRemoveMember = defineTool({
  name: 'workspace_remove_member',
  title: 'Remove a member',
  description:
    'Removes a member from the workspace; their agent keys for it stop working. Without confirm: true it only previews the removal and changes nothing. The workspace’s owner can’t be removed. Owner only.',
  toolset: 'workspace',
  inputSchema: z.strictObject({ userId: MemberUserId, confirm: confirmField }),
  outputSchema: Output,
  annotations: {
    readOnlyHint: false,
    destructiveHint: true,
    idempotentHint: false,
    openWorldHint: false,
  },
  scopes: ['workspace:share'],
  minRole: 'owner',
  async preview(ctx, input) {
    const member = await findMemberView(toolCaller(ctx), input.userId);
    return {
      output: {
        applied: false,
        member,
        summary:
          'Preview: this member would be removed and their agent keys here revoked. Nothing changed; call again with confirm: true to remove them.',
      },
      target: { type: 'user', id: member.userId },
    };
  },
  async handler(ctx, input) {
    const member = await findMemberView(toolCaller(ctx), input.userId);
    await Member.remove(toolCaller(ctx), member.userId);
    return {
      output: { applied: true, member, summary: 'The member was removed.' },
      target: { type: 'user', id: member.userId },
    };
  },
});
