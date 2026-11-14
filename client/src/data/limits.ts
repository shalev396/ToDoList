import { PLAN_LIMITS } from '@api-types/limits.ts';

/**
 * The free plan's limits as the public pages state them (pricing, FAQ), read from the one source
 * the server enforces: server/src/types/limits.ts. The i18n strings name these keys as
 * placeholders, e.g. {{membersPerWorkspace}}, and never hold the numbers themselves.
 */
export const limits = {
  workspacesCreatedPerUser: PLAN_LIMITS.workspacesCreatedPerUser,
  membersPerWorkspace: PLAN_LIMITS.membersPerWorkspace,
  integrationsPerUserPerWorkspace: PLAN_LIMITS.integrationsPerUserPerWorkspace,
  integrationsPerWorkspace: PLAN_LIMITS.integrationsPerWorkspace,
  agentKeysPerUser: PLAN_LIMITS.agentKeysPerUser,
  manualSyncIntervalMinutes: PLAN_LIMITS.manualSyncIntervalMs / 60_000,
  blocksPerPage: PLAN_LIMITS.blocksPerPage,
  viewsPerPage: PLAN_LIMITS.viewsPerPage,
  attributesPerWorkspace: PLAN_LIMITS.attributesPerWorkspace,
} as const;

/** Local to-dos per workspace, or null when there is no cap (the plan's "unlimited to-dos"). */
export const todosPerWorkspace: number | null = PLAN_LIMITS.todosPerWorkspace;
