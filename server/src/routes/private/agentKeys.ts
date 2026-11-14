import { Router } from 'express';
import { AgentKeysController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type { AgentScope } from '../../types/domain.js';

/**
 * Agent keys for MCP clients (DATA.md §3.14). The raw key is shown once, in the response that
 * creates it; only its SHA-256 hash is stored.
 */
const router = Router();

/** A key without its secret. `userId` is shown to owners only. */
export interface AgentKeyView {
  id: string;
  userId?: string;
  name: string;
  /** "elk_" + 4 characters. */
  prefix: string;
  scopes: AgentScope[];
  expiresAt: Date | null;
  lastUsedAt: Date | null;
  revokedAt: Date | null;
}

// ─── GET /api/private/workspaces/:wid/agent-keys ────────────────────────────

/** Viewer: my own keys, revoked ones included. Owner: everyone's, with `userId`. */
export type ListAgentKeysResponseData = AgentKeyView[];

router.get('/workspaces/:wid/agent-keys', requireWorkspace('viewer'), AgentKeysController.list);

// ─── POST /api/private/workspaces/:wid/agent-keys ───────────────────────────

/**
 * Owner. 201 with the raw `key`, which is never retrievable again. `expiresInDays` is 1–365
 * (default 365). 409 at the cap of keys per user (config/limits.ts).
 */
export interface CreateAgentKeyRequestBody {
  name: string;
  scopes: AgentScope[];
  expiresInDays?: number;
}

export type CreateAgentKeyResponseData = AgentKeyView & { key: string };

router.post('/workspaces/:wid/agent-keys', requireWorkspace('owner'), AgentKeysController.create);

// ─── DELETE /api/private/workspaces/:wid/agent-keys/:id ─────────────────────

/** Owner, or the key's own user: revokes it, 204. An unknown key, or another user's for a non-owner: 404. */
router.delete(
  '/workspaces/:wid/agent-keys/:id',
  requireWorkspace('viewer'),
  AgentKeysController.revoke,
);

export { router as agentKeysRouter };
