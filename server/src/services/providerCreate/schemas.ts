/** Request shapes of the provider-create routes (zod 4). Strict: an unknown key is a 400. */
import { z } from 'zod';

import { CREATE_STEPS } from '../../types/providerCreate.js';

const Id = z.string().min(1).max(200);

export const CreateOptionsQuerySchema = z.strictObject({
  step: z.enum(CREATE_STEPS),
  siteId: Id.optional(),
  projectId: Id.optional(),
  issueTypeId: Id.optional(),
  workspaceId: Id.optional(),
  spaceId: Id.optional(),
  folderId: Id.optional(),
  linearTeamId: Id.optional(),
  repo: Id.optional(),
});

export const CreateTargetSchema = z.discriminatedUnion('provider', [
  z.strictObject({
    provider: z.literal('jira'),
    siteId: Id.optional(),
    projectId: Id,
    issueTypeId: Id,
    team: z.strictObject({ fieldId: Id, id: Id }).optional(),
    assignMe: z.boolean().optional(),
  }),
  z.strictObject({ provider: z.literal('clickup'), listId: Id }),
  z.strictObject({
    provider: z.literal('linear'),
    teamId: Id,
    projectId: Id.optional(),
    stateId: Id.optional(),
  }),
  z.strictObject({
    provider: z.literal('github'),
    repo: Id,
    labels: z.array(z.string().min(1).max(50)).max(20).optional(),
  }),
  z.strictObject({ provider: z.literal('google_calendar'), calendarId: Id }),
]);

export const CreateCopyBody = z.strictObject({
  requestId: z.string().min(8).max(64),
  integrationId: Id,
  target: CreateTargetSchema,
  retryAnyway: z.boolean().optional(),
});

/** MCP and REST: the targets of `items_create`, at most one per integration. */
export const CreateTargetsInput = z
  .array(z.strictObject({ integrationId: Id, target: CreateTargetSchema }))
  .max(6)
  .refine(
    (targets) => new Set(targets.map((entry) => entry.integrationId)).size === targets.length,
    'targets: at most one per integration',
  );
