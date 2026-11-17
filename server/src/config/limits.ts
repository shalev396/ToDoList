import { PLAN_LIMITS } from '../types/limits.js';

/**
 * Free-tier caps the server enforces. TodoList is a free service, so these keep one user or one
 * workspace from using an unbounded share of it. A request over a count cap is answered 409, so the
 * user can make room (remove a member, delete a workspace, revoke a key) and retry. A request over
 * a rate limit (invite emails) is answered 429: wait, then retry.
 *
 * The plan's sizes come from types/limits.ts, the one source the pricing page and the FAQ state;
 * the rate limits below them are operational and stay on the server.
 */
export const LIMITS = Object.freeze({
  /** Workspaces a user may own at once (created, not deleted). */
  workspacesCreatedPerUser: PLAN_LIMITS.workspacesCreatedPerUser,
  /** Active members of one workspace; pending invites count too when inviting. */
  membersPerWorkspace: PLAN_LIMITS.membersPerWorkspace,
  /** Connected (not deleted) integrations one member owns in one workspace. */
  integrationsPerUserPerWorkspace: PLAN_LIMITS.integrationsPerUserPerWorkspace,
  /** Connected (not deleted) integrations in one workspace, every member's together. */
  integrationsPerWorkspace: PLAN_LIMITS.integrationsPerWorkspace,
  /** Agent keys a user may hold that are not revoked. */
  agentKeysPerUser: PLAN_LIMITS.agentKeysPerUser,
  /** "Sync now": at most once per 5 minutes per integration. */
  manualSyncIntervalMs: PLAN_LIMITS.manualSyncIntervalMs,
  /** Invite emails one workspace may send in any 24 hours (withdrawn or replaced ones count). */
  inviteEmailsPerWorkspacePerDay: 50,
  /** One workspace sends the same address at most one invite email per 10 minutes. */
  inviteResendCooldownMs: 600000,
  /** "Test connection" runs at most this often per integration in any minute (each may decrypt). */
  connectionTestsPerMinute: 5,
  /** Creates in one provider by one user in any hour (H5). */
  providerCreatesPerHour: PLAN_LIMITS.providerCreatesPerHour,
});
