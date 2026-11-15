import { Router } from 'express';
import { McpOAuthConsentController } from '../../controllers/index.js';
import type { ConsentView } from '../../classes/mcp/index.js';
import type { AgentScope } from '../../types/domain.js';

/**
 * The consent page's API (MCP sign-in): the member, signed in to TodoList, decides what an agent
 * may do. Any signed-in member may use it; the role of each workspace limits the scopes
 * (McpAuthorization). An unknown, used or expired request is 404 `request_expired`.
 */
const router = Router();

export type { ConsentView, ConsentWorkspace } from '../../classes/mcp/index.js';

// ─── GET /api/private/mcp-oauth/requests/:id ────────────────────────────────

/** Who is asking, and per workspace what this member may give and what the page ticks first. */
export type GetConsentResponseData = ConsentView;

router.get('/mcp-oauth/requests/:id', McpOAuthConsentController.describe);

// ─── POST /api/private/mcp-oauth/requests/:id/approve ───────────────────────

/**
 * One workspace, scopes the member's role there permits (400 `scope_not_allowed`), and a name for
 * the agent. 409 `agent_key_cap` at the cap. Answers where to send the browser: the client's
 * redirect URI with the single-use `code`.
 */
export interface ApproveConsentRequestBody {
  workspaceId: string;
  scopes: AgentScope[];
  name: string;
}

export interface ConsentRedirect {
  redirectTo: string;
}

export type ApproveConsentResponseData = ConsentRedirect;

router.post('/mcp-oauth/requests/:id/approve', McpOAuthConsentController.approve);

// ─── POST /api/private/mcp-oauth/requests/:id/deny ──────────────────────────

/** The client's redirect URI with `error=access_denied`. */
export type DenyConsentResponseData = ConsentRedirect;

router.post('/mcp-oauth/requests/:id/deny', McpOAuthConsentController.deny);

export { router as mcpOAuthPrivateRouter };
