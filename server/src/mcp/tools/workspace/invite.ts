import { z } from 'zod';

import { emailInvite, inviteUrl } from '../../../services/inviteDelivery.js';
import { CreateInviteBody } from '../../../services/workspaceSchemas.js';
import { createInvite } from '../../../services/workspaces.js';
import { toolCaller } from '../../auth/principal.js';
import { defineTool } from '../../tool.js';
import { InviteView, toInviteView } from './views.js';

const Input = CreateInviteBody.extend({
  email: CreateInviteBody.shape.email.describe('The invitee’s email address'),
  role: CreateInviteBody.shape.role.describe('editor or viewer: the owner is who created it'),
});

export const workspaceInvite = defineTool({
  name: 'workspace_invite',
  title: 'Invite a member',
  description:
    'Invites an email address to the whole workspace as an editor or viewer. Creates a pending invite that expires in 7 days (it replaces a pending invite to the same address) and emails the invitee, who accepts in the TodoList app. Returns the invite’s details; the invite link only ever goes to the invitee. Owner only.',
  toolset: 'workspace',
  inputSchema: Input,
  outputSchema: z.object({ invite: InviteView }),
  annotations: {
    readOnlyHint: false,
    destructiveHint: false,
    idempotentHint: false,
    openWorldHint: true,
  },
  scopes: ['workspace:share'],
  minRole: 'owner',
  async handler(ctx, input) {
    const { message, language, ...invitation } = input;
    const { invite, rawToken } = await createInvite(
      ctx.workspace,
      ctx.principal.userId,
      invitation,
      ctx.principal.agentId,
      toolCaller(ctx).actor,
    );
    // The link goes to the invitee by email, as REST sends it, and never to the agent.
    await emailInvite(ctx.workspace, ctx.principal.userId, invite, inviteUrl(rawToken), {
      message,
      language,
    });
    return {
      output: { invite: toInviteView(invite) },
      target: { type: 'invite', id: invite.id },
    };
  },
});
