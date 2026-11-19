/** The workspace toolset (MCP.md §7.5), in catalog order. */
import type { ToolDef } from '../../tool.js';
import { auditLogQuery } from './auditLogQuery.js';
import { workspaceInvite } from './invite.js';
import { workspaceListMembers } from './listMembers.js';
import { workspaceRemoveMember } from './removeMember.js';
import { setFileUnder } from './setFileUnder.js';
import { setTopicColour } from './setTopicColour.js';
import { workspaceUpdateMember } from './updateMember.js';
import { workspaceGet } from './workspaceGet.js';

export const WORKSPACE_TOOLS: readonly ToolDef[] = [
  workspaceGet,
  workspaceListMembers,
  workspaceInvite,
  workspaceUpdateMember,
  workspaceRemoveMember,
  setTopicColour,
  setFileUnder,
  auditLogQuery,
];
