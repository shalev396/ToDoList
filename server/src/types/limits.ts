/**
 * The free plan's limits: the one source the server enforces and the public pages state
 * (`@api-types/limits`). TodoList has one plan, Individual: free, with no feature limits. These
 * sizes only keep one person or one workspace from using an unbounded share of a free service.
 *
 * - The server reads them in config/limits.ts (next to its operational rate limits) and in the
 *   builder's CAPS (blocks per page).
 * - The client's pricing page and FAQ read them through client/src/data/limits.ts.
 *
 * Pure TypeScript with no imports, so the public pages load it without the server's code.
 */
export interface PlanLimits {
  /** Workspaces a user may own at once (created, not deleted). */
  readonly workspacesCreatedPerUser: number;
  /** Active members of one workspace; pending invites count too when inviting. */
  readonly membersPerWorkspace: number;
  /**
   * Connected (not deleted) integrations one member owns in one workspace (PERMISSIONS-V2 ruling
   * 19): integrations belong to one user inside one workspace.
   */
  readonly integrationsPerUserPerWorkspace: number;
  /** Connected (not deleted) integrations in one workspace, every member's together: sync costs. */
  readonly integrationsPerWorkspace: number;
  /** Agent keys (MCP access for AI agents) a user may hold that are not revoked. */
  readonly agentKeysPerUser: number;
  /** "Sync now": at most once per this many milliseconds per integration. */
  readonly manualSyncIntervalMs: number;
  /** Blocks on one dashboard page: the builder's CAPS.maxBlocks. */
  readonly blocksPerPage: number;
  /** Views (tabs) on one page, the Summary included. Enforced when per-page views ship (H3). */
  readonly viewsPerPage: number;
  /** Custom attributes in one workspace, the built-in Importance included. */
  readonly attributesPerWorkspace: number;
  /** Local to-dos in one workspace; null means there is no cap. */
  readonly todosPerWorkspace: number | null;
  /** To-dos a user may create in one provider (Jira, ClickUp…) per hour: a guard, not a plan. */
  readonly providerCreatesPerHour: number;
}

export const PLAN_LIMITS: PlanLimits = Object.freeze({
  workspacesCreatedPerUser: 5,
  membersPerWorkspace: 25,
  integrationsPerUserPerWorkspace: 20,
  integrationsPerWorkspace: 100,
  agentKeysPerUser: 10,
  manualSyncIntervalMs: 300_000,
  blocksPerPage: 40,
  viewsPerPage: 20,
  attributesPerWorkspace: 20,
  todosPerWorkspace: null,
  providerCreatesPerHour: 30,
});
