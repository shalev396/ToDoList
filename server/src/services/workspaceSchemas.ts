/**
 * Request bodies of the workspace routes (zod 4). Strict objects: an unknown key is a 400, so a
 * typo never passes silently. The services re-check their own rules (slug format and uniqueness,
 * roles, limits), so these only shape the input; MCP tools can reuse them as input schemas.
 */
import { z } from 'zod';

import { canonicalTimeZone } from '../utils/timeZone.js';
import { TOPIC_RULE_MATCH_MAX, TOPIC_RULES_MAX, WORKSPACE_NAME_MAX } from './workspaces.js';

const WorkspaceName = z.string().trim().min(1).max(WORKSPACE_NAME_MAX);
const TimeZone = z
  .string()
  .max(100)
  .refine((value) => canonicalTimeZone(value) !== null, 'Must be a valid IANA time zone');
/** Members are editors or viewers: the owner is whoever created the workspace. */
const MemberRole = z.enum(['editor', 'viewer']);

export const CreateWorkspaceBody = z.strictObject({
  name: WorkspaceName,
  /** Format (400) and uniqueness (409) are checked by createWorkspace. */
  slug: z.string().max(100).optional(),
  loadDemoData: z.boolean().optional(),
  timezone: TimeZone.optional(),
  /** The UI language: the title of the first page. */
  language: z.enum(['en', 'he']).optional(),
});

export const UpdateWorkspaceBody = z.strictObject({
  name: WorkspaceName.optional(),
  settings: z
    .strictObject({
      timezone: TimeZone.optional(),
      weekStart: z.enum(['sun', 'mon']).optional(),
      /** Replaced whole. Each rule files into a topic of this workspace (400 otherwise). */
      topicRules: z
        .array(
          z.strictObject({
            match: z.string().trim().min(1).max(TOPIC_RULE_MATCH_MAX),
            topicId: z.string().min(1).max(100),
          }),
        )
        .max(TOPIC_RULES_MAX)
        .optional(),
      allowAgentPublish: z.boolean().optional(),
    })
    .optional(),
});

export const CreateInviteBody = z.strictObject({
  email: z.string().trim().max(254).pipe(z.email()),
  role: MemberRole,
  /** A few words from the inviter, shown in the invite email. Not stored. */
  message: z.string().trim().max(500).optional(),
  /** The inviter's UI language: the email's. */
  language: z.enum(['en', 'he']).optional(),
});

export const SetJoinLinkBody = z.strictObject({
  enabled: z.boolean(),
  /** viewer for a new link when absent; an existing link keeps its role. */
  role: MemberRole.optional(),
});

export const AcceptJoinLinkBody = z.strictObject({
  token: z.string().min(1).max(200),
});

export const UpdateMemberBody = z.strictObject({
  role: MemberRole.optional(),
});

export const SetDefaultWorkspaceBody = z.strictObject({
  workspaceId: z.string().min(1).max(100),
});
