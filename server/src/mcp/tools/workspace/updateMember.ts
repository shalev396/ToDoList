import { z } from 'zod';

import { UpdateMemberBody } from '../../../services/workspaceSchemas.js';
import { Member } from '../../../classes/workspace/index.js';
import { Integration } from '../../../classes/integration/index.js';
import { confirmField } from '../../middleware/confirm.js';
import { toolCaller } from '../../auth/principal.js';
import { defineTool } from '../../tool.js';
import { findMemberView, MemberUserId, MemberView, toMemberView } from './views.js';

const Input = UpdateMemberBody.extend({
  userId: MemberUserId,
  role: UpdateMemberBody.shape.role.describe('editor or viewer'),
  confirm: confirmField,
});

const Output = z.object({
  applied: z.boolean().describe('false: a preview, nothing changed'),
  member: MemberView.describe('The member before the change (preview) or after it'),
  change: z.object({
    role: z.enum(['editor', 'viewer']).optional(),
  }),
  summary: z.string(),
});

export const workspaceUpdateMember = defineTool({
  name: 'workspace_update_member',
  title: 'Update a member',
  description:
    'Changes a member’s role (editor or viewer); every member sees the whole workspace. Without confirm: true it only previews the change and changes nothing. The workspace’s owner can’t be demoted, and nobody can be made an owner. Owner only.',
  toolset: 'workspace',
  inputSchema: Input,
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
    const change = { role: input.role };
    return {
      output: {
        applied: false,
        member,
        change,
        summary:
          change.role === undefined
            ? 'Preview: no change was given (set role). Nothing changed.'
            : 'Preview: this change would be applied to the member. Nothing changed; call again with confirm: true to apply it.',
      },
      target: { type: 'user', id: member.userId },
    };
  },
  async handler(ctx, input) {
    const change = { role: input.role };
    const member = await Member.update(toolCaller(ctx), input.userId, change);
    return {
      output: {
        applied: true,
        member: toMemberView(member, await Integration.providersByMember(ctx.workspace.id)),
        change,
        summary: 'The member was updated.',
      },
      target: { type: 'user', id: member.userId },
    };
  },
});
