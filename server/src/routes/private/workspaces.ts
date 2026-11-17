import { Router } from 'express';
import { WorkspacesController } from '../../controllers/index.js';
import { requireWorkspace } from '../../middlewares/requireWorkspace.js';
import type {
  TopicRule,
  WeekStart,
  WorkspaceSettings,
} from '../../models/definitions/Workspace.js';
import type { Role } from '../../types/domain.js';

const router = Router();

/** A workspace (a workspace in the API; DATA.md §3.2). */
export interface WorkspaceView {
  id: string;
  name: string;
  slug: string;
  /** Who created it. */
  ownerId: string;
  settings: WorkspaceSettings;
  createdAt: Date;
  updatedAt: Date;
}

/** One of my workspaces, with my standing in it. */
export interface MyWorkspaceView {
  workspace: WorkspaceView;
  role: Role;
}

// ─── GET /api/private/workspaces ────────────────────────────────────────────

/** My workspaces, oldest membership first. */
export type ListWorkspacesResponseData = MyWorkspaceView[];

router.get('/workspaces', WorkspacesController.list);

// ─── POST /api/private/workspaces ───────────────────────────────────────────

/**
 * 201 with the new workspace, which becomes my default. 409 at the cap of workspaces per
 * user (config/limits.ts) or for a taken slug; 400 for `loadDemoData` on prod.
 */
export interface CreateWorkspaceRequestBody {
  name: string;
  /** Lowercase letters and digits, single hyphens, 2–48 characters. Generated from the name if absent. */
  slug?: string;
  /** Demo data (FAKE integrations that never sync): dev and qa only, refused on prod. */
  loadDemoData?: boolean;
  /** The browser's IANA time zone. Default: Asia/Jerusalem. */
  timezone?: string;
}

export type CreateWorkspaceResponseData = WorkspaceView;

router.post('/workspaces', WorkspacesController.create);

// ─── GET /api/private/workspaces/:wid ───────────────────────────────────────

/** Any member. 404 for non-members, so a workspace's existence never leaks. */
export type GetWorkspaceResponseData = MyWorkspaceView;

router.get('/workspaces/:wid', requireWorkspace('viewer'), WorkspacesController.get);

// ─── PATCH /api/private/workspaces/:wid ─────────────────────────────────────

/** Owner. At least one change. Only the settings given change; arrays are replaced whole. */
export interface UpdateWorkspaceRequestBody {
  name?: string;
  settings?: {
    /** A valid IANA time zone, e.g. "Asia/Jerusalem". */
    timezone?: string;
    weekStart?: WeekStart;
    /** Replaced whole; each rule files into a topic of this workspace (400 otherwise). */
    topicRules?: TopicRule[];
    /** Let agent keys with builder:publish publish dashboards (MCP builder_publish). */
    allowAgentPublish?: boolean;
  };
}

export type UpdateWorkspaceResponseData = WorkspaceView;

router.patch('/workspaces/:wid', requireWorkspace('owner'), WorkspacesController.update);

// ─── DELETE /api/private/workspaces/:wid ────────────────────────────────────

/** Owner. 204, no body. Deletes the workspace's credentials and everything else in it. */
router.delete('/workspaces/:wid', requireWorkspace('owner'), WorkspacesController.remove);

// ─── PUT /api/private/me/default-workspace ──────────────────────────────────

/** The workspace the client opens next time (workspace switcher). 404 unless I am a member. */
export interface SetDefaultWorkspaceRequestBody {
  workspaceId: string;
}

export interface SetDefaultWorkspaceResponseData {
  defaultWorkspaceId: string;
}

router.put('/me/default-workspace', WorkspacesController.setDefault);

export { router as workspacesRouter };
